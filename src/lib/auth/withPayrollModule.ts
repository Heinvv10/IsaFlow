/**
 * The Payroll module gate for every pages/api/payroll/** handler (#1656, security review of #1670):
 * OPTIONS is answered 200 before anything; GET / HEAD need Payroll read, every other method Payroll write, from the user's module permissions
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

const READS = new Set(['GET', 'HEAD']);

/** Requests withPayrollModule has already granted Payroll READ for, so withPayrollDetailAccess does not ask the database again (round 3, L1). */
const readGranted = new WeakSet<object>();
export const payrollReadAlreadyGranted = (req: object): boolean => readGranted.has(req);

export function withPayrollModule(handler: Handler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // A pre-flight is answered here, as withErrorHandler answers it (200, no body): it never reaches a handler, whatever branch that
    // handler gives a method it does not know (#1656 round 8). Nothing is read, so no permission is asked.
    if ((req.method ?? '').toUpperCase() === 'OPTIONS') return res.status(200).end();
    const { companyId, user } = req as CompanyAuthedRequest;
    const action = READS.has((req.method ?? 'GET').toUpperCase()) ? 'read' : 'write';
    if (!companyId || !user?.id || !(await checkPermission(companyId, user.id, 'payroll', action))) {
      return apiResponse.forbidden(res, `Your permissions do not include Payroll ${action}. An owner or admin can grant it in User Access.`);
    }
    if (action === 'read') readGranted.add(req);
    return handler(req, res);
  };
}
