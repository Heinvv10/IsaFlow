/**
 * Admin User Activate API
 * POST /api/admin/users/[id]/activate — Reactivate a suspended user
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { activateUser } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'POST') {
    try {
      await activateUser(userId);

      await logAdminAction(
        req.user.id,
        'user.activate',
        'user',
        userId,
        {},
        getIp(req)
      );

      return apiResponse.success(res, { activated: true });
    } catch (err) {
      log.error('Failed to activate user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to activate user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
}

export default withAdmin(handler);
