/**
 * Admin Company Impersonation API
 * POST /api/admin/companies/[id]/impersonate
 * Creates a short-lived JWT allowing admin to view the app as a specific company.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { createImpersonationToken } from '@/modules/admin/services/impersonationService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyId = req.query.id as string;

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

export default withAdmin(handler);
