/**
 * The HTTP answer for a budget controls refusal (`BudgetControlsError`: 400 a bad account or slice,
 * 404 an override that is not this company's, 409 the email flag while sending is off on the
 * server) and for the alert evaluation's bounded lock wait (503 + Retry-After). Anything else is
 * not answered here: the route rethrows it and withErrorHandler answers 500.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { BudgetControlsError } from '@/modules/accounting/services/budgets/budgetControlSettings';

const CODE_FOR_STATUS = { 400: ErrorCode.BAD_REQUEST, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT } as const;

/** Owners and admins: who changes the controls and evaluates alerts (decision 9). */
export const BUDGET_CONTROL_ADMIN_ROLES: readonly string[] = ['owner', 'admin'];

/** True when `err` was answered. */
export function respondBudgetControlsError(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof BudgetControlsError) {
    apiResponse.error(res, CODE_FOR_STATUS[err.status], err.message);
    return true;
  }
  return respondIfLockTimeout(res, err);
}
