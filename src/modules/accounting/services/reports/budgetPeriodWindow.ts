/**
 * Which budget months a Budget vs Actual window covers, and what they add up to.
 *
 * Budgets are stored in `accounting_budgets.period_amounts` keyed by CALENDAR
 * month ('jan'..'dec'), because a company can change its fiscal year-end
 * without its January budget becoming a different number. The report window,
 * by contrast, is a fiscal window — for every company in this system that means
 * March to February. Mapping one onto the other by comparing `Date.getMonth()`
 * bounds silently produces an empty window as soon as the year-to-date range
 * crosses into January, and an empty window reads on screen as "no budget set".
 *
 * Dates arrive as 'YYYY-MM-DD' strings and are treated as strings throughout:
 * constructing a Date to read its month risks a UTC rollback moving a
 * first-of-the-month boundary into the previous month.
 */

/** Calendar month keys, Jan first — the keys the budget writer stores. */
export const BUDGET_MONTH_KEYS = [
  'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
] as const;

export type BudgetMonthKey = typeof BUDGET_MONTH_KEYS[number];

/** Months since year 0 — an orderable scalar that survives a year boundary. */
function monthOrdinal(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate);
  if (!match) return null;
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

/**
 * The calendar month keys from `startDate` to `endDate` inclusive, in window
 * order. Capped at twelve: a budget year has twelve months, and a wider request
 * would double-count them.
 */
export function budgetMonthKeysInWindow(startDate: string, endDate: string): BudgetMonthKey[] {
  const start = monthOrdinal(startDate);
  const end = monthOrdinal(endDate);
  if (start === null || end === null || end < start) return [];

  const span = Math.min(end - start + 1, BUDGET_MONTH_KEYS.length);
  const keys: BudgetMonthKey[] = [];
  for (let i = 0; i < span; i++) {
    keys.push(BUDGET_MONTH_KEYS[(start + i) % 12] as BudgetMonthKey);
  }
  return keys;
}

/**
 * Sum a stored `period_amounts` object over the given months.
 *
 * Rows written before the month-name shape used 0-based numeric keys, so both
 * are accepted. The annual amount is pro-rated only when no monthly split was
 * ever stored — gating on key count rather than on a zero total, so a
 * deliberate zero-budget month stays zero instead of resurrecting the annual.
 */
export function sumBudgetForWindow(
  periodAmounts: Record<string, unknown>,
  annualAmount: number,
  monthKeys: readonly BudgetMonthKey[],
): number {
  if (monthKeys.length === 0) return 0;

  if (Object.keys(periodAmounts).length === 0) {
    if (!annualAmount) return 0;
    return round2(Number(annualAmount) * (monthKeys.length / BUDGET_MONTH_KEYS.length));
  }

  let total = 0;
  for (const key of monthKeys) {
    const byName = periodAmounts[key];
    const byIndex = periodAmounts[String(BUDGET_MONTH_KEYS.indexOf(key))];
    total += Number(byName ?? byIndex ?? 0);
  }
  return round2(total);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
