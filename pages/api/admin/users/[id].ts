/**
 * Admin User Detail API
 * GET   /api/admin/users/[id] — Get user details
 * PATCH /api/admin/users/[id] — Update user fields
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
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

const PatchBody = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name:  z.string().min(1).max(100).optional(),
  // Pentest M21: tighten to enum so the schema can't drift away from the
  // service-layer allowlist in adminUserService.ts:238. super_admin is
  // deliberately absent — no path to self-promote via this endpoint.
  role:       z.enum(['admin', 'manager', 'storeman', 'technician', 'viewer']).optional(),
  phone:      z.string().max(30).optional(),
}).strict();

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
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { first_name, last_name, role, phone } = parsed.data;

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
        { fields: Object.keys(parsed.data) },
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
      return apiResponse.badRequestFromError(res, err, 'Failed to delete user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
