/**
 * The HTTP answer for a budget-driver refusal (Budgets P4 spec §5): 400 with `error.details.code`
 * DRIVER_CYCLE (plus `path`), DRIVER_REF or DRIVER_RANGE; a stale token 409 BUDGET_VERSION_STALE with
 * `currentUpdatedAt` and `status` (as the grid save answers it); anything else a version write
 * refuses goes through `respondBudgetVersionError` (400 / 403 / 404 / 409 / 503). Anything else is
 * not answered.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { driverRefusal } from '@/modules/accounting/services/budgets/drivers/driverErrors';
import { BudgetVersionStaleError } from '@/modules/accounting/services/budgets/versionTake';

/** True when `err` was answered. */
export function respondBudgetDriverError(res: NextApiResponse, err: unknown): boolean {
  const refusal = driverRefusal(err);
  if (refusal) {
    apiResponse.error(res, ErrorCode.BAD_REQUEST, refusal.message,
      refusal.path ? { code: refusal.code, path: refusal.path } : { code: refusal.code });
    return true;
  }
  if (err instanceof BudgetVersionStaleError) {
    apiResponse.error(res, ErrorCode.CONFLICT, err.message, { code: err.code, currentUpdatedAt: err.currentUpdatedAt, status: err.versionStatus });
    return true;
  }
  return respondBudgetVersionError(res, err);
}
