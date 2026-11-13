/**
 * The HTTP answer for a typed three-way refusal (budgets P6, spec §7, §13).
 * `error.details.code` carries the contract code the clients branch on:
 *   409 BUDGET_ASSUMPTIONS_STALE   `{ code, currentUpdatedAt }` (the row's token now, null when it has none)
 *   400 BUDGET_THREE_WAY_INPUT     a request the service refused (compare across years, …)
 *   400 BUDGET_SCENARIO_CHAIN      `{ code, reason, path }` (reason = AssumptionChainError code)
 *   400 BUDGET_ASSUMPTIONS_INVALID `{ code, issues: [{ path, message }] }`
 *   409 BUDGET_OPENING_UNBALANCED  `{ code, differenceCents }` (a broken trial balance, never plugged)
 * then everything `respondBudgetVersionError` answers (404 NOT_FOUND, 409 LOCKED, 503 row lock).
 * Anything else is not answered here.
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { AssumptionChainError, AssumptionsDocError, OpeningUnbalancedError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { AssumptionsStaleError, ThreeWayServiceError } from '@/modules/accounting/services/budgets/threeWay/serviceErrors';

/** True when `err` was answered. */
export function respondThreeWayError(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof AssumptionsStaleError) {
    apiResponse.error(res, ErrorCode.CONFLICT, err.message, { code: err.code, currentUpdatedAt: err.currentUpdatedAt });
    return true;
  }
  if (err instanceof ThreeWayServiceError) {
    apiResponse.error(res, err.status === 409 ? ErrorCode.CONFLICT : ErrorCode.BAD_REQUEST, err.message, { code: err.code });
    return true;
  }
  if (err instanceof AssumptionChainError) {
    apiResponse.error(res, ErrorCode.BAD_REQUEST, err.message, { code: 'BUDGET_SCENARIO_CHAIN', reason: err.code, path: err.path });
    return true;
  }
  if (err instanceof AssumptionsDocError) {
    apiResponse.error(res, ErrorCode.BAD_REQUEST, 'The assumptions document is invalid', { code: 'BUDGET_ASSUMPTIONS_INVALID', issues: err.issues });
    return true;
  }
  if (err instanceof OpeningUnbalancedError) {
    apiResponse.error(res, ErrorCode.CONFLICT, err.message, { code: 'BUDGET_OPENING_UNBALANCED', differenceCents: err.differenceCents });
    return true;
  }
  return respondBudgetVersionError(res, err);
}
