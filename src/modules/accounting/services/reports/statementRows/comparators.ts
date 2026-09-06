/**
 * Fills the `trend` and `budget` fields the row model reserved for this
 * workstream. Same contract as the other adapters in this directory: every
 * figure is COPIED from a service, nothing is derived — with two exceptions,
 * both inside `baseComparison` and both covered by
 * `tests/unit/services/reports/statementRows/comparators.test.ts`:
 *
 *   1. `variance` (the MOVEMENT, `actual − base`). `prior.variance` already
 *      arrives from the services pre-signed this way. `budget.variance`
 *      cannot use the service's own `line.variance` for this field — it is
 *      signed FAVOURABLY (revenue: actual − budget; expense: budget −
 *      actual), so on an expense it has the opposite sign to the movement.
 *      `applyBudgetComparator` computes it itself as `actual − budget`, and
 *      ROUNDS that subtraction to two decimals. Both operands are rands
 *      already rounded to the cent, so the only thing the rounding can
 *      remove is IEEE-754 noise: `130000.10 − 120000.20` evaluates to
 *      `9999.899999999994` in JavaScript, and a statement that prints
 *      `9,999.90` beside an unrounded figure the export re-derives is the
 *      screen and the export disagreeing over a number neither got wrong.
 *      It can never move a figure by a cent, because no input carries a
 *      third decimal.
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
 * Build a comparison for one row against a BASE figure — the prior period's
 * or the budget's. Named for the base, not for `prior`: both callers reach
 * it, and a name that says `prior` reads as if the budget column were being
 * built out of a prior-period helper.
 *
 * A base of EXACTLY ZERO is a real comparator, and the movement against it is
 * a real figure: an account that went from nothing to R5.5m moved by R5.5m,
 * and that is worth printing. What does NOT exist is the percentage — there
 * is nothing to divide by — so `variancePct` is left undefined, leaving that
 * one cell empty rather than printing a claim of "0.0%" (no change) beside
 * the largest movement on the statement.
 */
export function baseComparison(
  value: number,
  variance: number | undefined,
  favourable: (v: number) => boolean,
): Comparison {
  const variancePct = variance !== undefined && value !== 0
    ? (variance / Math.abs(value)) * 100
    : undefined;
  const comparison: Comparison = { value, variance, variancePct };
  if (variance !== undefined) comparison.favourable = favourable(variance);
  return comparison;
}

/** Only a coded line row carries an account-level comparator. A section,
 *  subtotal, total or grand row is a band, and no service returns a
 *  per-account figure for one. */
function isAccountLine(row: StatementRow): boolean {
  return row.kind === 'line' && row.accountCode !== undefined;
}

/**
 * No budget captured means every account's budget is zero, and applying the
 * comparator then prints a variance equal to the whole actual against a
 * target nobody set — a large red bar that is an artefact, not a finding.
 * Every caller of `applyBudgetComparator` — the statement pages via
 * `useStatementComparators` and the presentation deck via `PresentSlide` —
 * must check this before calling it, so the rule lives in one place.
 */
export function hasBudgetData(budgetedCount: number): boolean {
  return budgetedCount > 0;
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
    const budget = baseComparison(
      line.budget_amount,
      round2(line.actual_amount - line.budget_amount),
      () => line.variance >= 0,
    );
    return { ...row, budget };
  });
}

/** Two decimals, because rands are two decimals. See exception 1 in this
 *  file's header: this removes float noise from a subtraction of two
 *  already-rounded figures, never a real cent. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
