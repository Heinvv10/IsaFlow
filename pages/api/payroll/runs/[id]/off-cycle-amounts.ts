/**
 * /api/payroll/runs/[id]/off-cycle-amounts - a bonus run's amounts (wave 6 OC, review #1620 final breaker M).
 *  GET    the run's bonus inputs (employee, amount); [] for any other run.
 *  PATCH  { employeeId, amount, expectedAmount }: correct one amount on a draft or calculated bonus run
 *         (payrollOffCycleAmount). expectedAmount is the amount the editor saw: a stored amount that differs (another
 *         admin's correction) is a 409, before any write. The run goes back to draft until it is recalculated. Owner or admin only; refused under Login-as (403
 *         IMPERSONATION_FORBIDDEN); a run in any other state is a 409, judged before any write.
 *  Both: payroll-detail roles only (withPayrollDetailAccess); a cookie session only (no agent bearer).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { listOffCycleBonusInputs, setOffCycleBonusAmount } from '@/modules/accounting/services/payroll/payrollOffCycleAmount';
import { OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const id = String(req.query.id);
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');
  if (req.method === 'GET') return apiResponse.success(res, await listOffCycleBonusInputs(companyId, id));
  if (req.method !== 'PATCH') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
  if (companyRole !== 'owner' && companyRole !== 'admin') {
    return apiResponse.forbidden(res, 'Only an owner or admin can change a bonus amount.');
  }
  const body = (req.body ?? {}) as { employeeId?: unknown; amount?: unknown; expectedAmount?: unknown };
  if (typeof body.employeeId !== 'string' || !UUID_RE.test(body.employeeId)) return apiResponse.badRequest(res, 'employeeId is required');
  if (typeof body.amount !== 'number') return apiResponse.badRequest(res, 'amount must be a number');
  if (typeof body.expectedAmount !== 'number') return apiResponse.badRequest(res, 'expectedAmount (the amount being changed) must be a number');
  try {
    const userId = req.user?.id;
    if (!userId) return apiResponse.forbidden(res, 'Only a signed-in user can change a bonus amount.');
    const done = await setOffCycleBonusAmount(companyId, id, body.employeeId, body.amount, userId, body.expectedAmount);
    if (!done) return apiResponse.notFound(res, 'PayrollRun', id);
    return apiResponse.success(res, done);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof OffCycleRunRefusedError) {
      return err.status === 400 ? apiResponse.badRequest(res, err.message)
        : apiResponse.conflict(res, err.message, { code: err.code, ...(err.refusal ? { refusal: err.refusal } : {}) });
    }
    throw err;
  }
}

// Per-employee pay: payroll-detail roles only, for GET too (review #1620 security). withAuth is a cookie session only,
// so an agent's bearer token (PAT or OAuth) never reaches this route.
// The request log masks each employee's amount (review #1679 B1): an employee id beside what they are paid.
export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(withWriteAccess(handler))), { maskBodyKeys: ['amount', 'expectedAmount'] }));
