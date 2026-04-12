/**
 * Admin User Detail API
 * GET   /api/admin/users/[id] — Get user details
 * PATCH /api/admin/users/[id] — Update user fields
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getUserDetail,
  updateUser,
} from '@/modules/admin/services/adminUserService';
import { deleteUser } from '@/modules/admin/services/adminUserActionsService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';


async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const user = await getUserDetail(userId);
      if (!user) {
        return apiResponse.notFound(res, 'User', userId);
      }
      return apiResponse.success(res, user);
    } catch (err) {
      log.error('Failed to get user detail', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get user detail');
    }
  }

  if (req.method === 'PATCH') {
    try {
      const {
        first_name,
        last_name,
        role,
        phone,
      } = req.body as Record<string, string | undefined>;

      await updateUser(userId, { first_name, last_name, role, phone });

      const updated = await getUserDetail(userId);
      if (!updated) {
        return apiResponse.notFound(res, 'User', userId);
      }

      await logAdminAction(
        req.user.id,
        'user.update',
        'user',
        userId,
        { fields: Object.keys(req.body as object) },
        getIp(req)
      );

      return apiResponse.success(res, updated);
    } catch (err) {
      log.error('Failed to update user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to update user');
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteUser(userId);

      await logAdminAction(
        req.user.id,
        'user.delete',
        'user',
        userId,
        {},
        getIp(req),
      );

      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Failed to delete user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to delete user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(handler);
