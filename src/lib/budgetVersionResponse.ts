/**
 * The HTTP answer for a typed budget-version refusal (migration 947): 400 input or grain clash,
 * 403 role, 404 not found (another tenant's id included), 409 locked, illegal state or stale.
 * `error.details.code` carries the contract code (BUDGET_VERSION_LOCKED, …) the clients branch on.
 * A held version row is the shared 503 + Retry-After. Anything else is not answered here.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

const CODE_FOR_STATUS = {
  400: ErrorCode.BAD_REQUEST,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
} as const;

/** True when `err` was answered. */
export function respondBudgetVersionError(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof BudgetVersionError) {
    apiResponse.error(res, CODE_FOR_STATUS[err.status], err.message, { code: err.code });
    return true;
  }
  return respondIfLockTimeout(res, err);
}
