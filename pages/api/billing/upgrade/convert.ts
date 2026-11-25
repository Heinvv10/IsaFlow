/**
 * POST /api/billing/upgrade/convert   Body: { planId }
 *
 * Self-serve upgrade, last step: convert the owner's own trial company to the
 * plan (convertOwnTrial: trialConvertCore's conversion, shared with the admin
 * "Convert to Paid", plus a tenant audit_log row in the same transaction).
 * Refused unless an active, chargeable Paystack mandate is on file. Calling it
 * again for the same plan answers 200 with alreadyConverted: true and writes
 * nothing.
 *
 * 404 without the dark flag `trial_self_serve_upgrade` (every role) or for an
 * unknown plan; 403 for any role but owner and for a company not on a trial (or
 * already paying on another plan); 400 for a plan that cannot be chosen; 409
 * without a mandate or with a paused subscription. The company is the verified
 * request's; a company id in the body is a 400.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { UUID } from '@/lib/schemas/common';
import { getIp } from '@/utils/getIp';
import { TrialConvertError } from '@/modules/admin/services/trialErrors';
import { convertOwnTrial } from '@/modules/billing/services/selfServeUpgrade';
import { withSelfServeUpgradeFlag } from '@/modules/billing/services/selfServeUpgradeGate';

const Body = z.object({ planId: UUID.transform((id) => id.toLowerCase()) }).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  const { planId } = parsed.data;

  try {
    const result = await convertOwnTrial({
      companyId: req.companyId,
      userId: req.user!.id,
      userEmail: req.user?.email,
      planId,
      ip: getIp(req) ?? undefined,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    });
    return apiResponse.success(res, {
      planId,
      subscriptionId: result.subscriptionId,
      firstChargeAt: result.firstChargeAt,
      alreadyConverted: result.alreadyConverted,
    });
  } catch (err) {
    // A refusal is raised before anything is written; anything else is a 500.
    if (!(err instanceof TrialConvertError)) throw err;
    switch (err.code) {
      case 'company_not_found': return apiResponse.notFound(res, 'Company');
      case 'plan_not_found': return apiResponse.notFound(res, 'Plan');
      case 'not_on_trial':
      case 'already_paid':
      case 'company_not_convertible': return apiResponse.forbidden(res, 'This company is not on a trial that can be upgraded.');
      case 'mandate_required': return apiResponse.conflict(res, 'Authorise a payment method before upgrading.');
      case 'subscription_paused': return apiResponse.conflict(res, err.message);
      case 'plan_not_convertible': return apiResponse.badRequest(res, 'This plan cannot be chosen for an upgrade.');
    }
  }
}

// The flag is checked before the role, so a company without it gets 404 whatever the role.
export default withAuth(withErrorHandler(withCsrf(withSelfServeUpgradeFlag(
  withWriteAccess(handler, { allowedRoles: ['owner'] }),
))));
