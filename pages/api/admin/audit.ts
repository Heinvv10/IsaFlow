/**
 * Admin Audit Log API
 * GET /api/admin/audit — Retrieve paginated admin audit log
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getAuditLog } from '@/modules/admin/services/auditService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const {
        admin_user_id,
        target_type,
        target_id,
        action,
        from_date,
        to_date,
        page,
        limit,
      } = req.query;

      const result = await getAuditLog({
        admin_user_id: admin_user_id as string | undefined,
        target_type: target_type as string | undefined,
        target_id: target_id as string | undefined,
        action: action as string | undefined,
        from_date: from_date as string | undefined,
        to_date: to_date as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get audit log', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get audit log');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
