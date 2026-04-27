/**
 * Pure helper for the Budget vs Actual report. Builds the list of report
 * lines from raw GL aggregate rows + a budget lookup map, applying the
 * variance / variance% rules and the "drop empty (zero/zero) rows" filter.
 *
 * Extracted from pages/api/accounting/reports-budget-vs-actual.ts so the
 * logic can be unit-tested without mocking the SQL layer.
 */

export interface RawActualRow {
  id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  actual_amount: number | string;
}

export interface BudgetVsActualLine {
  account_code: string;
  account_name: string;
  account_type: string;
  budget_amount: number;
  actual_amount: number;
  variance: number;
  variance_pct: number;
}

/**
 * Look up the budget for an account. Both `account_code` and `id` are
 * accepted as keys because callers may store budgets keyed by either.
 *
 * Uses `??` (nullish coalescing) instead of `||` so a legitimate zero
 * budget — `{ '6000': 0 }` — is preserved instead of silently falling
 * through to the id-keyed entry. A zero budget is meaningfully different
 * from "no budget set" for the variance calculation.
 */
function lookupBudget(budgets: Record<string, number>, row: RawActualRow): number {
  const byCode = budgets[row.account_code];
  if (byCode !== undefined) return Number(byCode);
  const byId = budgets[row.id];
  if (byId !== undefined) return Number(byId);
  return 0;
}

/**
 * Apply the variance rules:
 *   - Revenue: positive variance = good (actual > budget)
 *   - Expense: positive variance = good (actual < budget, i.e. under budget)
 */
function computeVariance(
  accountType: string,
  budgetAmount: number,
  actualAmount: number,
): number {
  if (accountType === 'revenue') return actualAmount - budgetAmount;
  return budgetAmount - actualAmount;
}

/**
 * Variance percentage. When the budget is zero we can't compute a real
 * percentage (division by zero), so we use sentinel values:
 *   - `-100`  : actual movement happened but no budget was set ("over by 100%
 *               of nothing"). Magnitude is intentionally lost; the consumer
 *               UI should display "—" or use `budget_amount === 0` to flag
 *               the row instead of relying on the percent.
 *   - `0`     : no budget AND no actual — neutral.
 * This sentinel behaviour is preserved verbatim from the legacy inline code
 * to avoid surprising existing report consumers.
 */
function computeVariancePct(
  budgetAmount: number,
  actualAmount: number,
  variance: number,
): number {
  if (budgetAmount > 0) return (variance / budgetAmount) * 100;
  return actualAmount > 0 ? -100 : 0;
}

/**
 * Build the report lines from raw aggregate rows + a budget map.
 *
 * Header rows (a parent account that's never had a journal entry posted to
 * it AND has no budget) appear as zero/zero from the SQL aggregate; the
 * filter at the end of the pipeline drops them so the report is not
 * cluttered with empty entries.
 *
 * Rows with EITHER a budget OR an actual movement are kept — including a
 * brand-new account that has a budget set but no actuals yet.
 */
export function buildBudgetVsActualLines(
  actuals: RawActualRow[],
  budgets: Record<string, number>,
): BudgetVsActualLine[] {
  return actuals
    .map(a => {
      const budgetAmount = lookupBudget(budgets, a);
      const actualAmount = Number(a.actual_amount);
      const variance = computeVariance(a.account_type, budgetAmount, actualAmount);
      const variancePct = computeVariancePct(budgetAmount, actualAmount, variance);
      return {
        account_code: a.account_code,
        account_name: a.account_name,
        account_type: a.account_type,
        budget_amount: budgetAmount,
        actual_amount: actualAmount,
        variance,
        variance_pct: variancePct,
      };
    })
    .filter(l => l.budget_amount !== 0 || l.actual_amount !== 0);
}
