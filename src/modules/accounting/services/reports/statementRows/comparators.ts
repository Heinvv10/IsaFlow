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
 * A prior of EXACTLY ZERO carries no movement worth printing. The services
 * hand back `variance = actual` and `variancePct = 0` in that case — divide by
 * zero has no percentage, so zero is the placeholder — and the grid then draws
 * a full-width variance bar next to a Δ% of 0.0%, which reads as "no change by
 * the largest movement on the statement". Both are artefacts of an absent
 * comparator, not findings about the account, so both are left undefined and
 * the cells print empty. Same judgement the budget column already makes: a
 * comparator with nothing behind it prints nothing.
 *
 * `favourable` goes with them. A polarity verdict on a movement that is not
 * shown would colour a figure the reader cannot see.
 */
export function priorComparison(
  value: number,
  variance: number | undefined,
  variancePct: number | undefined,
  favourable: (v: number) => boolean,
): Comparison {
  if (value === 0) return { value };
  const prior: Comparison = { value, variance, variancePct };
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
