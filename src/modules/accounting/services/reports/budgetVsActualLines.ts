/**
 * Pure helper for the Budget vs Actual report: THE row model every budget
 * surface reads (screen, CSV, MCP, the statement Budget column, bullets).
 * Builds the report lines from raw GL aggregate rows + a budget lookup map.
 * Nothing outside this file derives a variance, a percentage or a sign.
 *
 * Two variances, on purpose (shared contract, "Variance sign"):
 *   - `variance` is signed FAVOURABLY (revenue A−B, expense B−A). MCP,
 *     the presentation bullets and the net-profit invariant read it.
 *   - `movement` is actual − budget for every type. Screens and exports
 *     print it; `favourable` alone says whether it is good news.
 */

import { round2 } from '../core/budgetMonths';

export interface RawActualRow {
  id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  actual_amount: number | string;
}

export type BudgetLineType = 'revenue' | 'expense';

export interface BudgetVsActualLine {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: BudgetLineType;
  /** A budget_month_amounts row exists in the window. A deliberate zero budget counts. */
  budgeted: boolean;
  /** 0 when !budgeted. */
  budget_amount: number;
  /** Revenue credit − debit, expense debit − credit. */
  actual_amount: number;
  /** Favourably signed: revenue actual − budget, expense budget − actual. */
  variance: number;
  /** actual − budget, for every type: the sign screens and exports print. */
  movement: number;
  /** variance / |budget| × 100; null when the budget is zero or absent. */
  variance_pct: number | null;
  /** movement / |budget| × 100; same null rule. The % screens and exports print. */
  movement_pct: number | null;
  /** variance ≥ 0; null when nothing was budgeted. */
  favourable: boolean | null;
}

/**
 * The budget for an account, or undefined when none is stored. Keyed by the
 * account ID only: a code shares no key space with ids, so an account coded
 * like another account's id (or like `constructor`) cannot pick up a budget
 * that is not its own. A present key, even at 0, is a budget.
 */
function lookupBudget(budgets: Readonly<Record<string, number>>, row: RawActualRow): number | undefined {
  return Object.hasOwn(budgets, row.id) ? Number(budgets[row.id]) : undefined;
}

/** A percentage of a budget, or null when there is nothing to divide by. A negative budget divides by its size. */
export function pctOfBudget(amount: number, budget: number, budgeted: boolean): number | null {
  if (!budgeted || budget === 0) return null;
  return (amount / Math.abs(budget)) * 100;
}

/**
 * Build the report lines from raw aggregate rows + a budget map.
 *
 * A row is kept when it is budgeted (even at zero, even with no actuals) or
 * carries movement. An unbudgeted zero/zero row (a header, a dormant account)
 * is dropped.
 */
export function buildBudgetVsActualLines(
  actuals: RawActualRow[],
  /** Budget per account over the window, keyed by gl_accounts.id. */
  budgets: Readonly<Record<string, number>>,
): BudgetVsActualLine[] {
  return actuals
    .map<BudgetVsActualLine>((a) => {
      const stored = lookupBudget(budgets, a);
      const budgeted = stored !== undefined;
      const budget = stored ?? 0;
      const actual = Number(a.actual_amount);
      const type: BudgetLineType = a.account_type === 'revenue' ? 'revenue' : 'expense';
      const movement = round2(actual - budget);
      const variance = type === 'revenue' ? movement : round2(budget - actual);
      return {
        account_id: String(a.id),
        account_code: a.account_code,
        account_name: a.account_name,
        account_type: type,
        budgeted,
        budget_amount: budget,
        actual_amount: actual,
        variance,
        movement,
        variance_pct: pctOfBudget(variance, budget, budgeted),
        movement_pct: pctOfBudget(movement, budget, budgeted),
        favourable: budgeted ? variance >= 0 : null,
      };
    })
    .filter((l) => l.budgeted || l.actual_amount !== 0);
}
