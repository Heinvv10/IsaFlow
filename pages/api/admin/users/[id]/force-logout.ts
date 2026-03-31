/**
 * Admin User Force Logout API
 * POST /api/admin/users/[id]/force-logout — Invalidate all active sessions for a user
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { forceLogout } from '@/modules/admin/services/adminUserService';
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
      await forceLogout(userId);

      await logAdminAction(
        req.user.id,
        'user.force_logout',
        'user',
        userId,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { logged_out: true });
    } catch (err) {
      log.error('Failed to force logout user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to force logout user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
