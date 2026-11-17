/**
 * GET /api/payroll/employees/[id]/email  { email }        payroll-detail roles
 * PUT /api/payroll/employees/[id]/email  { email|null }   payroll-detail roles, own session, never Login-as; changing
 *                                                         or clearing an address already set: owner / admin only (403)
 *
 * The address an employee's payslips are emailed to (wave 6 PE; payrollEmployeeEmail). Judged before any write; a
 * change is audited with its before and after. Another company's employee is 404. Every response is no-store.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailActor, UUID } from '@/lib/payslipEmailApi';
import {
  EmployeeEmailForbidden, EmployeeEmailRefused, judgeEmployeeEmail, readEmployeeEmail, setEmployeeEmail,
} from '@/modules/accounting/services/payroll/payrollEmployeeEmail';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (req.method === 'GET') {
    const email = await readEmployeeEmail(companyId, id);
    return email === undefined ? apiResponse.notFound(res, 'PayrollEmployee', id) : apiResponse.success(res, { email });
  }
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'email') || !('email' in body)) {
    return apiResponse.badRequest(res, 'The body is { email } only');
  }
  let email: string | null;
  try {
    email = judgeEmployeeEmail(body.email);
  } catch (err) {
    if (err instanceof EmployeeEmailRefused) return apiResponse.badRequest(res, err.message);
    throw err;
  }
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  let saved: { email: string | null } | null;
  try {
    saved = await setEmployeeEmail(companyId, id, email, actor, companyRole === 'owner' || companyRole === 'admin');
  } catch (err) {
    if (err instanceof EmployeeEmailForbidden) return apiResponse.forbidden(res, err.message);
    throw err;
  }
  return saved ? apiResponse.success(res, saved) : apiResponse.notFound(res, 'PayrollEmployee', id);
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
