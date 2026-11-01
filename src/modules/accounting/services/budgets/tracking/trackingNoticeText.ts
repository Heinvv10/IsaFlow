/**
 * The words of the budget notices that the Budget vs Actual page, the income statement's Budget column
 * and the BvA export all say, ONE string each (budgets P3 PR-C review r3): two copies drifted by a
 * clause, and a reader comparing the two pages read the difference as a different fact. Pure.
 */

/** A financial year of the window with no budget in it (no version, or no income-statement row). */
export const noBudgetYearNotice = (fiscalYear: number): string =>
  `No budget for FY${fiscalYear} in this window: its Budget and variance columns are shown as —, never as zero.`;

/** A financial year with a budget, none of it at the dimension filter (set at other cost centres). */
export const budgetElsewhereNotice = (fiscalYear: number): string =>
  `FY${fiscalYear} has a budget, but none of it is at this filter.`;
