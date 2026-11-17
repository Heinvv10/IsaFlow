/**
 * The pay-run review grid's period inputs (master plan wave 3, R).
 * GET /api/payroll/runs/[id]/inputs  - the run, what it may edit, what is captured
 * PUT /api/payroll/runs/[id]/inputs  - { employeeId, componentId, amount, expectedAmount } in rand; 0 clears
 *                                    or (HD) { employeeId, quantity, expectedQuantity[, expectedAmount] } hours or days; the amount
 *                                    is worked out on the server from the employee's rate. quantity null clears the row, 0 is an
 *                                    entered nil; expectedQuantity null = no row; expectedAmount names a plain amount it replaces
 *                                    or (RI) { employeeId, units: { kind: 'overtime' | 'travel', multiplier (1.5 | 2; null for travel),
 *                                    quantity (hours or km; null clears), ratePerKm (travel), expectedQuantity } }, priced on the server
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
import { setRunHours } from '@/modules/accounting/services/payroll/payrollRunHoursInput';
import { setRunUnits, type UnitEntry } from '@/modules/accounting/services/payroll/payrollRunUnitsInput';

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

  const { employeeId, componentId, amount, expectedAmount, quantity, expectedQuantity, units } = (req.body ?? {}) as Record<string, unknown>;
  const actor = { userId: req.user.id, userEmail: req.user.email, channel: 'rest' } as const;
  if (units !== undefined) {
    const entry = parseUnits(units);
    if (!isUuid(employeeId) || typeof entry === 'string') return apiResponse.badRequest(res, typeof entry === 'string' ? entry : 'employeeId is required');
    if ([componentId, amount, expectedAmount, quantity, expectedQuantity].some((v) => v !== undefined)) return apiResponse.badRequest(res, 'Send units alone');
    try {
      return apiResponse.success(res, await setRunUnits(companyId, id, employeeId, entry, actor));
    } catch (err) {
      return refused(res, id, err);
    }
  }
  const hours = quantity !== undefined || expectedQuantity !== undefined;
  if (hours) {
    if (!isUuid(employeeId)) return apiResponse.badRequest(res, 'employeeId is required');
    if (componentId !== undefined || amount !== undefined) return apiResponse.badRequest(res, 'Send hours or days, or an amount, not both');
    if (quantity !== null && typeof quantity !== 'number') return apiResponse.badRequest(res, 'quantity must be a number, or null to clear');
    if (expectedQuantity !== null && typeof expectedQuantity !== 'number') return apiResponse.badRequest(res, 'expectedQuantity must be a number, or null for none');
    if (expectedAmount !== undefined && expectedAmount !== null && typeof expectedAmount !== 'number') return apiResponse.badRequest(res, 'expectedAmount must be a number');
  } else {
    if (!isUuid(employeeId) || !isUuid(componentId)) return apiResponse.badRequest(res, 'employeeId and componentId are required');
    if (typeof amount !== 'number') return apiResponse.badRequest(res, 'amount must be a number');
    if (typeof expectedAmount !== 'number') return apiResponse.badRequest(res, 'expectedAmount must be a number');
  }

  try {
    return apiResponse.success(res, hours
      ? await setRunHours(companyId, id, employeeId as string, quantity as number | null, {
        quantity: expectedQuantity as number | null, amount: (expectedAmount ?? null) as number | null,
      }, actor)
      : await setRunPeriodAmount(companyId, id, employeeId as string, componentId as string, amount as number, expectedAmount as number, actor));
  } catch (err) {
    return refused(res, id, err);
  }
}

/** A refusal answers 4xx (nothing was written); anything else is rethrown, so the 500 rolls the write back. */
function refused(res: NextApiResponse, id: string, err: unknown): void {
  if (respondIfLockTimeout(res, err)) return;
  if (err instanceof PayrollRunInputRefusedError) {
    if (err.status === 404) return apiResponse.notFound(res, 'PayrollRun', id);
    if (err.status === 409) return apiResponse.conflict(res, err.message);
    return apiResponse.badRequest(res, err.message);
  }
  throw err;
}

const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));

/** RI's `units` body, strictly: every key known, each of its type. A string is the 400's message. */
function parseUnits(v: unknown): UnitEntry | string {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'units must be an object';
  const u = v as Record<string, unknown>;
  const extra = Object.keys(u).filter((k) => !['kind', 'multiplier', 'quantity', 'ratePerKm', 'expectedQuantity'].includes(k));
  if (extra.length > 0) return `Unknown units field: ${extra.join(', ')}`;
  if (u.kind !== 'overtime' && u.kind !== 'travel') return "units.kind must be 'overtime' or 'travel'";
  if (!numOrNull(u.multiplier) || !numOrNull(u.quantity) || !numOrNull(u.expectedQuantity) || !numOrNull(u.ratePerKm ?? null)) {
    return 'units.multiplier, quantity, ratePerKm and expectedQuantity must be numbers or null';
  }
  return { kind: u.kind, multiplier: u.multiplier, quantity: u.quantity, ratePerKm: (u.ratePerKm ?? null) as number | null, expectedQuantity: u.expectedQuantity };
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
