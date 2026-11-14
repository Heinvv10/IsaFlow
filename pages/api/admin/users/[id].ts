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
import { deleteUser, SoleOwnerError } from '@/modules/admin/services/adminUserActionsService';
import {
  assertSuperAdminRemains, LastSuperAdminError, LAST_SUPER_ADMIN_REASON,
} from '@/modules/admin/services/superAdminRosterService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PatchBody = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name:  z.string().min(1).max(100).optional(),
  // Pentest M21: tighten to enum so the schema can't drift away from the
  // service-layer allowlist in adminUserService.ts:238. super_admin is accepted
  // ONLY as the target's unchanged role (the edit form sends the role with every
  // save); the handler refuses it as a promotion — no path to self-promote.
  role:       z.enum(['admin', 'manager', 'storeman', 'technician', 'viewer', 'super_admin']).optional(),
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

    const { first_name, last_name, phone } = parsed.data;
    let role = parsed.data.role;
    // A role change may take a super admin out of the console: the roster check locks and refuses the last active
    // one (admin audit 2026-11-14, 3.3); a role sent unchanged is no change (the edit form sends it with every save).
    // Only that refusal is caught; any other failure is a 500 that rolls the update back with its audit row.
    let target = null;
    if (role !== undefined) {
      try {
        target = await assertSuperAdminRemains(userId, role);
      } catch (err) {
        if (err instanceof LastSuperAdminError) return apiResponse.conflict(res, err.message, { reason: LAST_SUPER_ADMIN_REASON });
        throw err;
      }
      if (!target) return apiResponse.notFound(res, 'User', userId);
      if (role === 'super_admin' && !target.isSuperAdmin) return apiResponse.badRequest(res, 'Cannot promote to super_admin');
      if (role === target.role) role = undefined;
    }

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
      {
        fields: Object.keys(parsed.data),
        ...(target && role !== undefined ? { previous_role: target.role, role } : {}), // only a real change
        ...(target?.isSuperAdmin ? { target_super_admin: true } : {}),
      },
      getIp(req)
    );

    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    try {
      const stranded = await deleteUser(userId);

      await logAdminAction(
        req.user.id,
        'user.delete',
        'user',
        userId,
        // Pending pay-run approvals this left without another approver (the deletion is never refused for them).
        stranded.length > 0 ? { stranded_pay_run_requests: stranded } : {},
        getIp(req),
      );

      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      // A company's only owner (migration 908b): nothing was deleted.
      if (err instanceof SoleOwnerError) return apiResponse.conflict(res, err.message);
      log.error('Failed to delete user', { userId, error: err }, 'admin-api');
      return apiResponse.badRequestFromError(res, err, 'Failed to delete user');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
