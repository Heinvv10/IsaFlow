/**
 * The HTTP side of the employee portal (wave 6 SS; spec rules 11, 12, 14, 20).
 *
 * `employeePortalAccessHandler(mailer)` is the staff route GET/POST/DELETE /api/payroll/employees/[id]/portal-access,
 * built around the Mailer it is given: the page wraps it with `sendEmail`, the integration suite wraps the same
 * handler, in the same middleware, with a capture mailer. Nothing selects the mailer from the environment.
 * Invite and revoke: owner or admin, a person signed in as themselves, never Login-as (payslipEmailActor), judged
 * before any read of the employee.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from '@/lib/auth';
import { payslipEmailActor, UUID } from '@/lib/payslipEmailApi';
import type { Mailer } from '@/modules/accounting/services/payroll/payslipDeliveryService';
import { EmployeePortalRefusal } from '@/modules/accounting/services/payroll/employeePortalRefusal';
import {
  inviteEmployeeToPortal, readEmployeePortalAccess, revokeEmployeePortalAccess,
} from '@/modules/accounting/services/payroll/employeePortalAccess';

const CODE: Record<number, ErrorCode> = {
  400: ErrorCode.BAD_REQUEST, 403: ErrorCode.FORBIDDEN, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT, 429: ErrorCode.RATE_LIMIT,
};

export function respondIfEmployeePortalRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof EmployeePortalRefusal)) return false;
  apiResponse.error(res, CODE[err.status]!, err.message, { reason: err.reason });
  return true;
}

/** The invite's send limit, charged after every other refusal (the route supplies it: pages/api/…/portal-access.ts). */
export type AdmitPortalInvite = (req: NextApiRequest, companyId: string) => Promise<boolean>;

export function employeePortalAccessHandler(mailer: Mailer, admit: AdmitPortalInvite) {
  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    const { companyId, companyRole } = req as CompanyAuthedRequest;
    const id = req.query.id;
    if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
    if (req.method === 'GET') {
      const view = await readEmployeePortalAccess(companyId, id);
      return view ? apiResponse.success(res, view) : apiResponse.notFound(res, 'PayrollEmployee', id);
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
    }
    if (!['owner', 'admin'].includes(companyRole)) {
      return apiResponse.forbidden(res, 'Only an owner or admin can invite an employee to the portal or end their access.');
    }
    const actor = await payslipEmailActor(req, res);
    if (!actor) return;
    try {
      if (req.method === 'DELETE') {
        await revokeEmployeePortalAccess(companyId, id, actor);
        return apiResponse.success(res, await readEmployeePortalAccess(companyId, id));
      }
      return apiResponse.success(res, await inviteEmployeeToPortal({
        companyId, employeeId: id, actor, mailer,
        admit: () => admit(req, companyId),
      }));
    } catch (err) {
      if (respondIfEmployeePortalRefused(res, err)) return;
      throw err;
    }
  };
}
