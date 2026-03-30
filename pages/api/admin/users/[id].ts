/**
 * Admin User Detail API
 * GET   /api/admin/users/[id] — Get user details
 * PATCH /api/admin/users/[id] — Update user fields
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getUserDetail,
  updateUser,
} from '@/modules/admin/services/adminUserService';
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

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
