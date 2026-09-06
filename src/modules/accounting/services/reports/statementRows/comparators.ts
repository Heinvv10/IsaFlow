/**
 * Fills the `trend` and `budget` fields the row model reserved for this
 * workstream. Same contract as the other adapters in this directory: every
 * figure is COPIED from a service, nothing is derived.
 *
 * One subtraction happens here and it is deliberate: `budget.variance` is
 * `actual − budget`, the MOVEMENT, because that is what `prior.variance`
 * means on every existing row and what `StatementRowView` prints. The
 * service's own `line.variance` cannot be used for that field — it is signed
 * FAVOURABLY (revenue: actual − budget; expense: budget − actual), so on an
 * expense it has the opposite sign to the movement. It is used for the
 * POLARITY and nothing else.
 */
import type { BudgetVsActualLine } from '../budgetVsActualLines';
import type { AccountTrends } from '../trendRowsService';
import type { Comparison, StatementRow } from './statementModel';

/**
 * Build the prior-period comparison for one row.
 *
 * A prior of EXACTLY ZERO is a real comparator, and the movement against it is
 * a real figure: an account that went from nothing to R5.5m moved by R5.5m,
 * and that is worth printing. What does NOT exist is the percentage — there is
 * nothing to divide by — and the services return 0 as the placeholder, which
 * the grid then prints as "0.0%": a claim of no change beside the largest
 * movement on the statement. So the amount and its polarity are kept and only
 * `variancePct` is dropped, leaving that one cell empty.
 */
export function priorComparison(
  value: number,
  variance: number | undefined,
  variancePct: number | undefined,
  favourable: (v: number) => boolean,
): Comparison {
  // No denominator, no percentage. The services' 0 is a placeholder for a
  // figure that does not exist, not a measurement of one.
  const prior: Comparison = value === 0
    ? { value, variance }
    : { value, variance, variancePct };
  if (variance !== undefined) prior.favourable = favourable(variance);
  return prior;
}

/** Only a coded line row carries an account-level comparator. A section,
 *  subtotal, total or grand row is a band, and no service returns a
 *  per-account figure for one. */
function isAccountLine(row: StatementRow): boolean {
  return row.kind === 'line' && row.accountCode !== undefined;
}

export function applyTrend(rows: StatementRow[], trends: AccountTrends): StatementRow[] {
  return rows.map((row) => {
    if (!isAccountLine(row)) return row;
    if (trends.unavailable[row.accountCode!] !== undefined) return row;
    const series = trends.byAccountCode[row.accountCode!];
    if (series === undefined) return row;
    return { ...row, trend: series };
  });
}

export function applyBudgetComparator(
  rows: StatementRow[],
  lines: BudgetVsActualLine[],
): StatementRow[] {
  const byCode = new Map(lines.map((l) => [l.account_code, l]));
  return rows.map((row) => {
    if (!isAccountLine(row)) return row;
    const line = byCode.get(row.accountCode!);
    if (line === undefined) return row;
    const budget = priorComparison(
      line.budget_amount,
      round2(line.actual_amount - line.budget_amount),
      line.variance_pct,
      () => line.variance >= 0,
    );
    return { ...row, budget };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
