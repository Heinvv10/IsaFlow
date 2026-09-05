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
    const budget: Comparison = {
      value: line.budget_amount,
      variance: round2(line.actual_amount - line.budget_amount),
      variancePct: line.variance_pct,
      favourable: line.variance >= 0,
    };
    return { ...row, budget };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
