/**
 * Permissions API (WS-4.1)
 *
 * GET    ?userId=X          — modules + user's custom permissions (admin/owner only)
 * POST                      — set permission for user on a module  (admin/owner only)
 *   body: { userId, moduleKey, canRead, canWrite, canDelete, canExport, canApprove,
 *            accountRangeFrom?, accountRangeTo? }
 * DELETE ?userId=X          — reset user to role defaults          (admin/owner only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { userBelongsToCompany } from '@/modules/accounting/services/core/companyAccessService';
import {
  isMemberWriteBusy, MemberRoleForbiddenError, resetMemberPermissions, setMemberApproveWithheld, setMemberModulePermission,
} from '@/modules/accounting/services/core/memberWrites';
import { OwnerProtectedError } from '@/modules/accounting/services/core/ownerLock';
import {
  getPermissionModules,
  getEffectivePermissions,
  getMemberAccess,
} from '@/lib/auth/permissionService';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';

const ADMIN_ROLES = ['owner', 'admin'];

/** A permission write the owner / admin check (memberWrites) refused, or that waited past the lock bound: 403 / 409; false for anything else. */
function respondIfPermissionWriteRefused(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof MemberRoleForbiddenError || err instanceof OwnerProtectedError) { apiResponse.forbidden(res, err.message); return true; }
  if (isMemberWriteBusy(err)) { apiResponse.conflict(res, 'Another change to this member is in progress. Nothing was changed; retry in a moment.'); return true; }
  return false;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;

  // All mutating operations are admin/owner only
  if (req.method !== 'GET' && !ADMIN_ROLES.includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only owners and admins can manage permissions.');
  }

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!ADMIN_ROLES.includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only owners and admins can view user permissions.');
    }

    const { userId } = req.query as { userId?: string };
    if (!userId) {
      return apiResponse.badRequest(res, 'userId query parameter is required.');
    }
    if (!isUuidParam(userId)) return apiResponse.notFound(res, 'User'); // names no member: no SQL cast to fail

    // #1656: a module the user has no row for shows the role default, the permission
    // checkPermission enforces (it showed all-off, so one toggle saved a row that also
    // took away the default read/write/export).
    const member = await getMemberAccess(companyId, userId);
    if (member === null) return apiResponse.notFound(res, 'User');
    const [modules, permissions] = await Promise.all([
      getPermissionModules(),
      getEffectivePermissions(companyId, userId, member.role, member.approveWithheld),
    ]);

    return apiResponse.success(res, { modules, permissions, approveWithheld: member.approveWithheld });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as {
      userId?: string;
      moduleKey?: string;
      canRead?: boolean;
      canWrite?: boolean;
      canDelete?: boolean;
      canExport?: boolean;
      canApprove?: boolean;
      accountRangeFrom?: string;
      accountRangeTo?: string;
    };

    const { userId, moduleKey } = body;
    if (!userId || !moduleKey) {
      return apiResponse.badRequest(res, 'userId and moduleKey are required.');
    }

    // Validate moduleKey exists
    const modules = await getPermissionModules();
    const validKeys = new Set(modules.map((m) => m.moduleKey));
    if (!validKeys.has(moduleKey)) {
      return apiResponse.badRequest(res, `Unknown moduleKey: ${moduleKey}`);
    }

    // The target user must already be a member of THIS company. Without this guard an
    // admin could pre-seed permission rows for a user from another tenant, which would
    // take effect if that user later joined this company (pentest H4 — phantom write).
    if (!(await userBelongsToCompany(userId, companyId))) {
      return apiResponse.notFound(res, 'User');
    }

    try {
      await setMemberModulePermission(companyId, userId, moduleKey, {
        canRead: Boolean(body.canRead),
        canWrite: Boolean(body.canWrite),
        canDelete: Boolean(body.canDelete),
        canExport: Boolean(body.canExport),
        canApprove: Boolean(body.canApprove),
        accountRangeFrom: body.accountRangeFrom ?? null,
        accountRangeTo: body.accountRangeTo ?? null,
      }, (req as CompanyAuthedRequest).user.id);
    } catch (err) {
      if (respondIfPermissionWriteRefused(res, err)) return;
      throw err;
    }

    log.info('Permission set via API', { companyId, userId, moduleKey }, 'PermissionsAPI');
    return apiResponse.success(res, { ok: true });
  }

  // ── PUT: withhold (or restore) the manager default of Approve and Payroll for one member (#1656 round 3) ──
  if (req.method === 'PUT') {
    const { userId, approveWithheld } = (req.body ?? {}) as { userId?: unknown; approveWithheld?: unknown };
    if (typeof userId !== 'string' || typeof approveWithheld !== 'boolean') {
      return apiResponse.badRequest(res, 'userId and approveWithheld (true or false) are required.');
    }
    if (!isUuidParam(userId) || !(await userBelongsToCompany(userId, companyId))) return apiResponse.notFound(res, 'User');
    try {
      await setMemberApproveWithheld(companyId, userId, approveWithheld, (req as CompanyAuthedRequest).user.id);
    } catch (err) {
      if (err instanceof MemberRoleForbiddenError || err instanceof OwnerProtectedError) return apiResponse.forbidden(res, err.message);
      throw err;
    }
    return apiResponse.success(res, { ok: true, approveWithheld });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { userId } = req.query as { userId?: string };
    if (!userId) {
      return apiResponse.badRequest(res, 'userId query parameter is required.');
    }
    if (!isUuidParam(userId)) return apiResponse.notFound(res, 'User');

    try {
      await resetMemberPermissions(companyId, userId, (req as CompanyAuthedRequest).user.id);
    } catch (err) {
      if (respondIfPermissionWriteRefused(res, err)) return;
      throw err;
    }
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
