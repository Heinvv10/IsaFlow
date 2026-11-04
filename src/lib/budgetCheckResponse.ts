/**
 * The HTTP answer to a budget-check refusal (budgets P5-2, spec §3b):
 * - `BudgetExceededError` → 409 `BUDGET_EXCEEDED`, `details.lines` = the over and off-slice lines (P5-2b). Its `refused`
 *   event is written HERE, after the approval's savepoint rolled back and on the request
 *   transaction, which withAuth COMMITs on a 4xx (census finding 4): the refusal is on record, the
 *   approval is not.
 * - `BudgetReasonRequiredError` → 400 `BUDGET_REASON_REQUIRED`, `details.lines` = every checked
 *   line (the dialog shows them). Nothing is written.
 * The retryable `BudgetCheckLockTimeoutError` is a `*_LOCK_TIMEOUT`: `respondIfLockTimeout` answers it 503.
 * Returns true when it answered.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { recordBudgetRefusal } from '@/modules/accounting/services/budgets/budgetCheck';
import { BudgetExceededError, BudgetReasonRequiredError } from '@/modules/accounting/services/budgets/budgetCheckTypes';

export async function respondIfBudgetRefused(res: NextApiResponse, err: unknown): Promise<boolean> {
  if (err instanceof BudgetExceededError) {
    await recordBudgetRefusal(err);
    apiResponse.conflict(res, err.message, { code: err.code, lines: err.overLines, overrideRefused: err.overrideRefused });
    return true;
  }
  if (err instanceof BudgetReasonRequiredError) {
    apiResponse.badRequest(res, err.message, { code: err.code, lines: err.lines });
    return true;
  }
  return false;
}
