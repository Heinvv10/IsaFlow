/**
 * GET  /api/payroll/runs/[id]/recurring-share   { pairs }       detail access: the run's employees whose line pays a
 *                                                recurring earning its share (W29) beside a once-off earning, acknowledged or not
 * POST /api/payroll/runs/[id]/recurring-share   { employeeId }  owner / admin, own session, never Login-as or an agent:
 *                                                acknowledge that employee's pair on this run (audited), after checking no
 *                                                once-off pro-rates the same days
 *
 * Wave 7 PRA, review #1901 M2 (coordinator decision A: the wave 6 FQd frequency-change pattern; payrollRecurringShareAck).
 * 409 RECURRING_SHARE_ACK_REFUSED when there is nothing to acknowledge or the run is past calculation; 404 for a run that
 * is not this company's.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailActor, UUID } from '@/lib/payslipEmailApi';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PayrollRunNotFoundError } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  acknowledgeRecurringShare, listRunSharePairs, RecurringShareAckRefused,
} from '@/modules/accounting/services/payroll/payrollRecurringShareAck';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (req.method === 'GET') {
    const row = ((await sql`SELECT id FROM payroll_run_headers WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid`) as DbRow[])[0];
    if (!row) return apiResponse.notFound(res, 'PayrollRun', id);
    return apiResponse.success(res, { pairs: await listRunSharePairs(companyId, id) });
  }
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
  if (companyRole !== 'owner' && companyRole !== 'admin') {
    return apiResponse.forbidden(res, 'Only an owner or admin can acknowledge a share beside a once-off.');
  }
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.employeeId !== 'string' || !UUID.test(body.employeeId)) {
    return apiResponse.badRequest(res, 'The body is { employeeId } only');
  }
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  try {
    return apiResponse.success(res, await acknowledgeRecurringShare(companyId, id, body.employeeId, actor));
  } catch (err) {
    if (err instanceof RecurringShareAckRefused) return apiResponse.conflict(res, err.message, { reason: err.code });
    if (err instanceof PayrollRunNotFoundError) return apiResponse.notFound(res, 'PayrollRun', id);
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withPayrollModule(withCsrf(withPayrollDetailAccess(handler)))));
