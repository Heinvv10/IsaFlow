/**
 * POST /api/billing/upgrade/start   Body: { planId }
 *
 * Self-serve upgrade, step 1: start a Paystack mandate authorisation for the
 * chosen plan (startMandateCheckout, the same code mandate/create runs). The
 * mandate ceiling is the plan's monthly price, read here, never from the body.
 * Paystack returns the payer to /accounting/settings/billing/upgrade/return,
 * which verifies the mandate and then converts (POST /api/billing/upgrade/convert).
 *
 * 404 without the dark flag `trial_self_serve_upgrade` (every role); 403 for
 * any role but owner and for a company not on a trial; 409 when a mandate is
 * already active (the owner confirms the upgrade instead). The company is the
 * verified request's; a company id in the body is a 400.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql, type DbRow } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';
import { isConvertiblePlanCode } from '@/modules/admin/types/trialPlans';
import { startMandateCheckout } from '@/modules/billing/services/mandateCheckout';
import { getUpgradeState } from '@/modules/billing/services/selfServeUpgrade';
import { withSelfServeUpgradeFlag } from '@/modules/billing/services/selfServeUpgradeGate';

const Body = z.object({ planId: UUID.transform((id) => id.toLowerCase()) }).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
  const { planId } = parsed.data;

  const state = await getUpgradeState(req.companyId);
  if (!state.onTrial) return apiResponse.forbidden(res, 'This company is not on a trial.');
  if (state.hasActiveMandate) {
    return apiResponse.conflict(res, 'A payment method is already authorised. Confirm the upgrade instead.');
  }

  const plan = (await sql`
    SELECT id, code, is_active, monthly_price_cents FROM plans WHERE id = ${planId}::uuid
  `)[0] as DbRow | undefined;
  if (!plan) return apiResponse.notFound(res, 'Plan');
  const maxAmountCents = Number(plan.monthly_price_cents);
  if (plan.is_active !== true || !isConvertiblePlanCode(String(plan.code)) || !Number.isInteger(maxAmountCents) || maxAmountCents <= 0) {
    return apiResponse.badRequest(res, 'This plan cannot be chosen for an upgrade.');
  }

  const result = await startMandateCheckout({
    companyId: req.companyId,
    userId: req.user!.id,
    userEmail: req.user?.email,
    maxAmountCents,
    callbackUrl: (reference) => `${process.env.NEXT_PUBLIC_APP_URL}/accounting/settings/billing/upgrade/return`
      + `?plan=${encodeURIComponent(planId)}&ref=${encodeURIComponent(reference)}`,
  });
  switch (result.kind) {
    case 'active_exists':
      return apiResponse.conflict(res, 'A payment method is already authorised. Confirm the upgrade instead.');
    case 'no_email':
      return apiResponse.badRequest(res, 'Your account has no email address to authorise the payment with.');
    case 'below_current_charge':
      // Unreachable for a company on a trial (it has no paid subscription); refused rather than assumed.
      return apiResponse.badRequest(res, 'This plan cannot be chosen for an upgrade.');
    case 'init_failed':
      return apiResponse.internalError(res, 'Could not start the payment authorisation. Please try again.');
    case 'started':
      return apiResponse.success(res, { checkoutUrl: result.checkoutUrl, reference: result.reference });
  }
}

// The flag is checked before the role, so a company without it gets 404 whatever the role.
export default withAuth(withErrorHandler(withCsrf(withSelfServeUpgradeFlag(
  withWriteAccess(handler, { allowedRoles: ['owner'] }),
))));
