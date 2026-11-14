/**
 * Admin Trials — Convert to Paid
 * POST /api/admin/trials/convert
 * Body: { companyId: string; planId: string }
 * 200 { companyId, planId, subscriptionId, converted } · 404 company/plan unknown · 400 plan not convertible · 409 already paying
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { markAsConverted, TrialConvertError } from '@/modules/admin/services/trialService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { UUID } from '@/lib/schemas/common';

const PostBody = z.object({
  companyId: UUID,
  planId:    UUID,
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
  }

  const { companyId, planId } = parsed.data;

  try {
    const { subscriptionId } = await markAsConverted(companyId, planId);

    await logAdminAction(
      req.user.id,
      'trial.convert_to_paid',
      'company',
      companyId,
      { planId, subscriptionId },
      getIp(req),
    );

    log.info('Trial converted to paid', { companyId, planId, subscriptionId }, 'admin-trials-convert');
    return apiResponse.success(res, { companyId, planId, subscriptionId, converted: true });
  } catch (err) {
    // A refusal is raised before anything is written, so answering 4xx commits nothing.
    // Anything else (a database error, a failed audit write) is a 500: the request's
    // transaction rolls back whole, and the client never sees the error text.
    if (err instanceof TrialConvertError) {
      switch (err.code) {
        case 'company_not_found': return apiResponse.notFound(res, 'Company');
        case 'plan_not_found': return apiResponse.notFound(res, 'Plan');
        case 'already_paid': return apiResponse.conflict(res, err.message);
        default: return apiResponse.badRequest(res, err.message);
      }
    }
    log.error('Failed to convert trial', { companyId, planId, error: err }, 'admin-trials-convert');
    throw err;
  }
}

export default withAdmin(withCsrf(handler));
