/**
 * Payroll-detail gate — per-employee pay is readable only by the roles that
 * can calculate and approve a run (owner/admin/manager, the withWriteAccess
 * set). Unlike withWriteAccess it also refuses GET: a viewer sees run totals
 * (the runs list) but never one person's gross or net pay. And (#1656) it needs Payroll read in
 * the user's module permissions (checkPermission, from the database): a former accountant /
 * bookkeeper, now a manager, has none (Hein, 2026-11-19), nor has a manager whose Payroll read an
 * owner or admin unticked.
 *
 * Wrap a handler that has already been through withAuth:
 *   export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
 */
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from './withAuth';
import { canWrite } from './writeRoles';
import { checkPermission } from './permissionService';
import { payrollReadAlreadyGranted } from './withPayrollModule';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => unknown | Promise<unknown>;

export function withPayrollDetailAccess(handler: Handler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const role = (req as CompanyAuthedRequest).companyRole;
    // No role means withAuth did not run first: fail closed, same as withWriteAccess.
    if (!canWrite(role)) {
      const what = req.method === 'GET' || req.method === 'HEAD' ? 'viewing payroll detail' : 'this action';
      return apiResponse.forbidden(res, `Your role (${role ?? 'unknown'}) does not allow ${what}.`);
    }
    const { companyId, user } = req as CompanyAuthedRequest;
    // withPayrollModule (outside this wrapper) has already asked Payroll read on a GET: not asked twice.
    if (!payrollReadAlreadyGranted(req) && !(await checkPermission(companyId, user.id, 'payroll', 'read'))) {
      return apiResponse.forbidden(res, 'Your permissions do not include Payroll. An owner or admin can grant it in User Access.');
    }
    return handler(req, res);
  };
}
