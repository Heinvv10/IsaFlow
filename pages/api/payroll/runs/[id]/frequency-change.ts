/**
 * GET  /api/payroll/runs/[id]/frequency-change   { straddles }  write roles: the run's employees whose first run at a new
 *                                                  pay frequency pays days twice or leaves days unpaid, acknowledged or not
 * POST /api/payroll/runs/[id]/frequency-change   { employeeId }  owner / admin, own session, never Login-as or an agent:
 *                                                  acknowledge that employee's days on this run (audited), after settling
 *                                                  them with a once-off adjustment
 *
 * Wave 6 FQd, breaker #1622 M2 (Hein ruling: refuse plus a once-off; payrollFrequencyStraddle). 409
 * FREQUENCY_STRADDLE_ACK_REFUSED when there is nothing to acknowledge or the run is past calculation; 404 for a run that
 * is not this company's.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailActor, UUID } from '@/lib/payslipEmailApi';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { listPayrollRunEmployees } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { payFrequencyOf, runPeriodOf } from '@/modules/accounting/services/payroll/payrollFrequency';
import {
  acknowledgeFrequencyStraddle, listRunStraddles, StraddleAckRefused,
} from '@/modules/accounting/services/payroll/payrollFrequencyStraddleAck';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (req.method === 'GET') {
    const row = ((await sql`SELECT * FROM payroll_run_headers WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid`) as DbRow[])[0];
    if (!row) return apiResponse.notFound(res, 'PayrollRun', id);
    const lines = ((await sql`SELECT employee_id FROM payroll_run_lines WHERE run_id = ${id}::uuid`) as DbRow[]).map((r) => String(r.employee_id));
    const population = (await listPayrollRunEmployees(companyId, runPeriodOf(row), payFrequencyOf(row.pay_frequency))).map((e) => e.id);
    return apiResponse.success(res, { straddles: await listRunStraddles(companyId, id, [...new Set([...lines, ...population])], row) });
  }
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
  if (companyRole !== 'owner' && companyRole !== 'admin') {
    return apiResponse.forbidden(res, 'Only an owner or admin can acknowledge a pay-frequency change.');
  }
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.employeeId !== 'string' || !UUID.test(body.employeeId)) {
    return apiResponse.badRequest(res, 'The body is { employeeId } only');
  }
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  try {
    return apiResponse.success(res, await acknowledgeFrequencyStraddle(companyId, id, body.employeeId, actor));
  } catch (err) {
    if (err instanceof StraddleAckRefused) return apiResponse.conflict(res, err.message, { reason: err.code });
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
