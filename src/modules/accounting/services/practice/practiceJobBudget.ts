/**
 * Engagement Budget — pure figures (no database), shared by the service, the
 * time entry form and the report.
 *
 * The budget is `practice_jobs.budget_amount` (migration 850). Consumption is
 * every time entry on the job except `leave`, valued at hours × applied_rate;
 * `practiceJobBudgetService` sums it. This file turns budget + consumption into
 * the balance and the warning state. It warns, it never blocks: amber from 80%
 * used, red once the balance is negative. A NULL budget is "No budget".
 */

export type JobBudgetState = 'none' | 'ok' | 'warning' | 'over';

export interface JobBudgetStatus {
  jobId: string;
  budgetAmount: number | null;
  consumedAmount: number;
  /** budgetAmount − consumedAmount; null when there is no budget. Negative = over. */
  balance: number | null;
  budgetedHours: number | null;
  hoursUsed: number;
  /** One decimal; null when there is no budget or the budget is zero. */
  percentUsed: number | null;
  state: JobBudgetState;
}

/**
 * Worked in cents so a float sum cannot move a threshold. Warning is
 * `used >= 80% of budget` (`used * 5 >= budget * 4`, exact in integers); over
 * is `used > budget`, i.e. a negative balance. A zero budget has no percentage.
 */
export function budgetFigures(
  budgetAmount: number | null,
  consumedAmount: number,
): Pick<JobBudgetStatus, 'balance' | 'percentUsed' | 'state'> {
  if (budgetAmount == null) return { balance: null, percentUsed: null, state: 'none' };
  const budgetC = Math.round(budgetAmount * 100);
  const usedC = Math.round(consumedAmount * 100);
  const state: JobBudgetState = usedC > budgetC ? 'over' : usedC * 5 >= budgetC * 4 ? 'warning' : 'ok';
  return {
    balance: (budgetC - usedC) / 100,
    percentUsed: budgetC > 0 ? Math.round((usedC * 1000) / budgetC) / 10 : null,
    state,
  };
}

/** Refusal raised for an Engagement Budget that is not a non-negative amount. Routes answer 400. */
export class JobBudgetInvalidError extends Error {
  readonly code = 'JOB_BUDGET_INVALID';
  constructor() {
    super('Engagement budget must be an amount from 0 up to R9,999,999,999,999.99');
    this.name = 'JobBudgetInvalidError';
  }
}

/**
 * Below 10^13 rand, so budget and consumption in cents stay well inside
 * Number's exact-integer range (2^53 ≈ 9.007e15): at 10^15 a stored
 * 123456789012345.67 already reads back a few cents off.
 */
export const MAX_BUDGET = 1e13;

/**
 * The Engagement Budget a caller sent: `null`/`''` mean "no budget"; otherwise
 * a finite number from 0 to below MAX_BUDGET. A string is refused rather than
 * coerced — the form sends a number. (`undefined` is the caller's "unchanged".)
 */
export function normaliseBudgetAmount(value: unknown): number | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_BUDGET) {
    throw new JobBudgetInvalidError();
  }
  return value;
}
