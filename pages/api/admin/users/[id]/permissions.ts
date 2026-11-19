/**
 * Admin per-module permissions for one user in one company (#1656: the admin portal edits the
 * app's model, the same company_user_permissions rows Settings -> User Access edits).
 *
 * GET    ?company_id=<uuid>  — the user's role there and their effective permission on every
 *                              module (their row, else the role default; owner/admin: everything)
 * POST   ?company_id=<uuid>  — body { company_id, moduleKey, canRead, canWrite, canDelete, canExport,
 *                              canApprove, accountRangeFrom?, accountRangeTo? }: set one module
 * DELETE ?company_id=<uuid>  — reset the user to their role defaults in that company
 *
 * 404 when the user is not linked to the company and 400 for an unknown module, both before
 * any write. POST and DELETE are audited (`user.set_module_permission`,
 * `user.reset_module_permissions`); a failed audit write propagates as a 500 and
 * withPlatformAdmin rolls the change back.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { AdminUuid, adminUuid } from '@/modules/admin/middleware/adminRequestErrors';
import { adminStoredUser } from '@/modules/admin/services/storedUserId';
import { apiResponse } from '@/lib/apiResponse';
import {
  getEffectivePermissions, getMemberRole, getPermissionModules, resetUserPermissions, setUserModulePermission,
} from '@/lib/auth/permissionService';
import { normalizeCompanyRole } from '@/lib/auth/companyRoles';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  company_id:       AdminUuid,
  moduleKey:        z.string().min(1).max(50),
  canRead:          z.boolean(),
  canWrite:         z.boolean(),
  canDelete:        z.boolean(),
  canExport:        z.boolean(),
  canApprove:       z.boolean(),
  accountRangeFrom: z.string().max(20).nullable().optional(),
  accountRangeTo:   z.string().max(20).nullable().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const userId = (await adminStoredUser(req.query.id)).id; // the stored id: acted on and audited exactly
  const companyId = adminUuid(req.query.company_id, 'company id');
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
  }

  const storedRole = await getMemberRole(companyId, userId);
  if (storedRole === null) return apiResponse.notFound(res, 'Company membership');
  const role = normalizeCompanyRole(storedRole);

  if (req.method === 'GET') {
    const [modules, permissions] = await Promise.all([
      getPermissionModules(),
      getEffectivePermissions(companyId, userId, storedRole), // the stored role: a former accountant has no approve
    ]);
    return apiResponse.success(res, { role, modules, permissions });
  }

  if (req.method === 'DELETE') {
    await resetUserPermissions(companyId, userId);
    await logAdminAction(req.user.id, 'user.reset_module_permissions', 'user', userId, { company_id: companyId }, getIp(req));
    return apiResponse.success(res, { ok: true });
  }

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid permission');
  }
  const body = parsed.data;
  if (body.company_id !== companyId) return apiResponse.badRequest(res, 'company_id must match the query');
  const modules = await getPermissionModules();
  if (!modules.some((m) => m.moduleKey === body.moduleKey)) {
    return apiResponse.badRequest(res, `Unknown moduleKey: ${body.moduleKey}`);
  }

  const perms = {
    canRead: body.canRead, canWrite: body.canWrite, canDelete: body.canDelete,
    canExport: body.canExport, canApprove: body.canApprove,
    accountRangeFrom: body.accountRangeFrom ?? null, accountRangeTo: body.accountRangeTo ?? null,
  };
  await setUserModulePermission(companyId, userId, body.moduleKey, perms);
  await logAdminAction(req.user.id, 'user.set_module_permission', 'user', userId,
    { company_id: companyId, module_key: body.moduleKey, ...perms }, getIp(req));
  return apiResponse.success(res, { ok: true });
}

export default withAdmin(withCsrf(handler));
