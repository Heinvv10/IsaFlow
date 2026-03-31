/**
 * Admin Company Activate API
 * POST /api/admin/companies/[id]/activate — Reinstate a suspended company
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { activateCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      await activateCompany(companyId);

      await logAdminAction(
        req.user.id,
        'company.activate',
        'company',
        companyId,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { activated: true });
    } catch (err) {
      log.error('Failed to activate company', { companyId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to activate company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
