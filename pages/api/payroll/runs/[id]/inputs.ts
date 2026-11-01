/**
 * The pay-run review grid's period inputs (master plan wave 3, R).
 * GET /api/payroll/runs/[id]/inputs  - the run, what it may edit, what is captured
 * PUT /api/payroll/runs/[id]/inputs  - { employeeId, componentId, amount, expectedAmount } in rand; 0 clears
 *
 * Both answer the same shape, so a PUT hands the grid the recalculated lines.
 * expectedAmount is what the cell last showed: a mismatch answers 409.
 * A refusal leaves nothing written, so it is a 4xx: withAuth COMMITs one, so
 * everything else is rethrown and the 500 rolls the write back.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import {
  PayrollRunInputRefusedError,
  getRunInputs,
  setRunPeriodAmount,
} from '@/modules/accounting/services/payroll/payrollRunPeriodInputs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (!isUuid(id)) return apiResponse.badRequest(res, 'Invalid payroll run ID');

  if (req.method === 'GET') {
    const state = await getRunInputs(companyId, id);
    if (!state) return apiResponse.notFound(res, 'PayrollRun', id);
    return apiResponse.success(res, state);
  }
  if (req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  }

  const { employeeId, componentId, amount, expectedAmount } = (req.body ?? {}) as Record<string, unknown>;
  if (!isUuid(employeeId) || !isUuid(componentId)) return apiResponse.badRequest(res, 'employeeId and componentId are required');
  if (typeof amount !== 'number') return apiResponse.badRequest(res, 'amount must be a number');
  if (typeof expectedAmount !== 'number') return apiResponse.badRequest(res, 'expectedAmount must be a number');

  try {
    return apiResponse.success(res, await setRunPeriodAmount(companyId, id, employeeId, componentId, amount, expectedAmount));
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    if (err instanceof PayrollRunInputRefusedError) {
      if (err.status === 404) return apiResponse.notFound(res, 'PayrollRun', id);
      if (err.status === 409) return apiResponse.conflict(res, err.message);
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
