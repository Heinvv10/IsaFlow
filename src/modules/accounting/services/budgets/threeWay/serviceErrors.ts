/**
 * Typed refusals of the three-way DB service (P6 PR C). The engine's own
 * refusals (`errors.ts`: chain, document, opening, compare) reach the routes
 * as they are and are answered by `@/lib/budgetThreeWayResponse`; version
 * refusals (404 not found, 409 locked) are P1's `BudgetVersionError`.
 */

export type ThreeWayServiceErrorCode = 'BUDGET_ASSUMPTIONS_STALE' | 'BUDGET_THREE_WAY_INPUT';

const STATUS: Record<ThreeWayServiceErrorCode, 400 | 409> = {
  BUDGET_ASSUMPTIONS_STALE: 409,
  BUDGET_THREE_WAY_INPUT: 400,
};

/** A refusal whose message is safe to show the caller; `status` is the HTTP answer. */
export class ThreeWayServiceError extends Error {
  readonly status: 400 | 409;
  constructor(readonly code: ThreeWayServiceErrorCode, message: string) {
    super(message);
    this.name = 'ThreeWayServiceError';
    this.status = STATUS[code];
  }
}

/**
 * 409: the assumptions changed since the client read them. `currentUpdatedAt` is
 * the row's token now (null: the row is gone, or none was ever written).
 */
export class AssumptionsStaleError extends ThreeWayServiceError {
  constructor(readonly currentUpdatedAt: string | null) {
    super('BUDGET_ASSUMPTIONS_STALE', 'These assumptions changed since you opened them; reload and re-apply your changes');
  }
}

export const threeWayInputError = (message: string): ThreeWayServiceError =>
  new ThreeWayServiceError('BUDGET_THREE_WAY_INPUT', message);
