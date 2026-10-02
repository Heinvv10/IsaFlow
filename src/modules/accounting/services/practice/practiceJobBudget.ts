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

/** NUMERIC(18,2): anything at or above 10^16 overflows the column. */
const MAX_BUDGET = 1e16;

/**
 * The Engagement Budget a caller sent: `null`/`''` mean "no budget"; otherwise
 * a finite, non-negative number. A string is refused rather than coerced — the
 * form sends a number.
 */
export function normaliseBudgetAmount(value: unknown): number | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= MAX_BUDGET) {
    throw new Error('Engagement budget must be a non-negative amount');
  }
  return value;
}
