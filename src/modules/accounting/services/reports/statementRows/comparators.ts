/**
 * Fills the `trend` and `budget` fields the row model reserved for this
 * workstream. Same contract as the other adapters in this directory: every
 * figure is COPIED from a service, nothing is derived — with two exceptions,
 * both inside `priorComparison` and both covered by
 * `tests/unit/services/reports/statementRows/comparators.test.ts`:
 *
 *   1. `variance` (the MOVEMENT, `actual − base`). `prior.variance` already
 *      arrives from the services pre-signed this way. `budget.variance`
 *      cannot use the service's own `line.variance` for this field — it is
 *      signed FAVOURABLY (revenue: actual − budget; expense: budget −
 *      actual), so on an expense it has the opposite sign to the movement.
 *      `applyBudgetComparator` computes it itself as `actual − budget`.
 *   2. `variancePct`, computed HERE from that same `variance` and `value`
 *      (`variance / |value| * 100`) so prior and budget cannot diverge: a
 *      caller-supplied percentage on a different sign convention (as
 *      `budgetVsActualLines`'s favourably-signed `variance_pct` is) can never
 *      leak through. `favourable` alone carries the judgement of whether a
 *      movement is good news; the sign of `variance`/`variancePct` is always
 *      "up is positive", never "good is positive".
 */
import type { BudgetVsActualLine } from '../budgetVsActualLines';
import type { AccountTrends } from '../trendRowsService';
import type { Comparison, StatementRow } from './statementModel';

/**
 * Build a comparison (prior or budget) for one row.
 *
 * A base of EXACTLY ZERO is a real comparator, and the movement against it is
 * a real figure: an account that went from nothing to R5.5m moved by R5.5m,
 * and that is worth printing. What does NOT exist is the percentage — there
 * is nothing to divide by — so `variancePct` is left undefined, leaving that
 * one cell empty rather than printing a claim of "0.0%" (no change) beside
 * the largest movement on the statement.
 */
export function priorComparison(
  value: number,
  variance: number | undefined,
  favourable: (v: number) => boolean,
): Comparison {
  const variancePct = variance !== undefined && value !== 0
    ? (variance / Math.abs(value)) * 100
    : undefined;
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
    const budget = priorComparison(
      line.budget_amount,
      round2(line.actual_amount - line.budget_amount),
      () => line.variance >= 0,
    );
    return { ...row, budget };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
