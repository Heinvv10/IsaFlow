/**
 * The Payroll module gate for every pages/api/payroll/** handler (#1656, security review of #1670):
 * GET / HEAD need Payroll read, every other method Payroll write, from the user's module permissions
 * in the database (checkPermission: owner / admin always; a manager unless unticked; a former
 * accountant / bookkeeper never, Hein 2026-11-19). It runs inside withAuth, around the rest of the
 * route's stack, before anything is read. The MCP payroll tools take the same rule in the registry
 * (src/lib/mcp/moduleFence.ts). tests/unit/auth/payrollModuleCensus.test.ts fails on a payroll
 * route that is not wrapped.
 */
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from './withAuth';
import { checkPermission } from './permissionService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => unknown | Promise<unknown>;

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function withPayrollModule(handler: Handler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const { companyId, user } = req as CompanyAuthedRequest;
    const action = READS.has((req.method ?? 'GET').toUpperCase()) ? 'read' : 'write';
    if (!companyId || !user?.id || !(await checkPermission(companyId, user.id, 'payroll', action))) {
      return apiResponse.forbidden(res, `Your permissions do not include Payroll ${action}. An owner or admin can grant it in User Access.`);
    }
    return handler(req, res);
  };
}
