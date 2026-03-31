/**
 * Admin User Suspend API
 * POST /api/admin/users/[id]/suspend — Suspend a user and invalidate sessions
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { suspendUser } from '@/modules/admin/services/adminUserService';
import { logAdminAction } from '@/modules/admin/services/auditService';

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      const { reason } = req.body as { reason?: string };

      if (!reason || reason.trim().length === 0) {
        return apiResponse.badRequest(res, 'A suspension reason is required');
      }

      await suspendUser(userId, reason.trim());

      await logAdminAction(
        req.user.id,
        'user.suspend',
        'user',
        userId,
        { reason },
        getIp(req)
      );

      return apiResponse.success(res, { suspended: true });
    } catch (err) {
      log.error('Failed to suspend user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to suspend user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
