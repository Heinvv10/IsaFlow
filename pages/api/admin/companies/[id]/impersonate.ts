/**
 * Admin Company Impersonation API
 * POST /api/admin/companies/[id]/impersonate
 * Creates a short-lived JWT allowing admin to view the app as a specific company.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { isMemberForImpersonation, NOT_A_MEMBER_FOR_IMPERSONATION } from '@/lib/auth/impersonationMembership';
import { companyCanBeImpersonated, createImpersonationToken } from '@/modules/admin/services/impersonationService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyId = req.query.id as string;

  // Per-user impersonation limit: 5 per minute to prevent abuse
  if (!(await checkRateLimit(`impersonate:${req.user.id}`, { max: 5, windowSecs: 60 }))) {
    return res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many impersonation attempts. Please wait a minute.' },
    });
  }

  // F-13 / review #1407: no token for a company impersonate-exchange would refuse, and nothing audited as a success.
  // A company that is missing, deleted, suspended or inactive is a 404; one the admin is not a member of is the
  // exchange's own 403.
  if (!(await companyCanBeImpersonated(companyId))) return apiResponse.notFound(res, 'Company');
  if (!(await isMemberForImpersonation(req.user.id, companyId))) {
    return apiResponse.forbidden(res, NOT_A_MEMBER_FOR_IMPERSONATION);
  }

  try {
    const { token, expires_at } = await createImpersonationToken(req.user.id, companyId);

    await logAdminAction(
      req.user.id,
      'company.impersonate',
      'company',
      companyId,
      { expires_at },
      getIp(req)
    );

    return apiResponse.success(res, { token, expires_at });
  } catch (err) {
    log.error('Failed to create impersonation token', { companyId, error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Failed to create impersonation token');
  }
}

export default withAdmin(withCsrf(handler));
