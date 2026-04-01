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
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import {
  getPermissionModules,
  getUserPermissions,
  setUserModulePermission,
  resetUserPermissions,
} from '@/modules/accounting/services/permissionService';
import { log } from '@/lib/logger';

const ADMIN_ROLES = ['owner', 'admin'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyApiRequest;

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

    const [modules, customMap] = await Promise.all([
      getPermissionModules(),
      getUserPermissions(companyId, userId),
    ]);

    const permissions = modules.map((mod) => {
      const custom = customMap.get(mod.moduleKey);
      return custom ?? {
        moduleKey: mod.moduleKey,
        moduleName: mod.moduleName,
        canRead: false,
        canWrite: false,
        canDelete: false,
        canExport: false,
        canApprove: false,
        accountRangeFrom: null,
        accountRangeTo: null,
        restrictions: {},
      };
    });

    return apiResponse.success(res, { modules, permissions });
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

    await setUserModulePermission(companyId, userId, moduleKey, {
      canRead: Boolean(body.canRead),
      canWrite: Boolean(body.canWrite),
      canDelete: Boolean(body.canDelete),
      canExport: Boolean(body.canExport),
      canApprove: Boolean(body.canApprove),
      accountRangeFrom: body.accountRangeFrom ?? null,
      accountRangeTo: body.accountRangeTo ?? null,
    });

    log.info('Permission set via API', { companyId, userId, moduleKey }, 'PermissionsAPI');
    return apiResponse.success(res, { ok: true });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { userId } = req.query as { userId?: string };
    if (!userId) {
      return apiResponse.badRequest(res, 'userId query parameter is required.');
    }

    await resetUserPermissions(companyId, userId);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
