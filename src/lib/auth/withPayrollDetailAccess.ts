/**
 * Payroll-detail gate — per-employee pay is readable only by the roles that
 * can calculate and approve a run (owner/admin/manager, the withWriteAccess
 * set). Unlike withWriteAccess it also refuses GET: a viewer sees run totals
 * (the runs list) but never one person's gross or net pay.
 *
 * Wrap a handler that has already been through withAuth:
 *   export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
 */
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from './withAuth';
import { canWrite } from './writeRoles';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => unknown | Promise<unknown>;

export function withPayrollDetailAccess(handler: Handler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const role = (req as CompanyAuthedRequest).companyRole;
    // No role means withAuth did not run first: fail closed, same as withWriteAccess.
    if (!canWrite(role)) {
      return apiResponse.forbidden(
        res,
        `Your role (${role ?? 'unknown'}) does not allow viewing payroll detail.`,
      );
    }
    return handler(req, res);
  };
}
