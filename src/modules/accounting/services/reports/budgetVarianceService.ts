/**
 * Budget variance: what was planned against what the ledger actually carries.
 *
 * A FACADE over the budgets P3 tracking engine (spec §3, PR-C). The figures
 * are `budgets/tracking/trackingRange.ts`'s: the engine's one actuals SQL
 * (`trackingActualRead`), its budget read, its dimension classes and its
 * budget-absent and partial rules. This file only maps them onto P0's
 * `BudgetVarianceResult`, which its consumers (the statement comparator, MCP
 * budget_variance, the board pack, the old Budget vs Actual routes) read.
 * With no options the result is deep-equal to the pre-facade service's on every
 * window (tests/integration/budget-variance-facade-parity.int.test.ts, whose
 * oracle is P0's own SQL; MCP budget_variance byte for byte:
 * budget-variance-mcp-default.int.test.ts).
 *
 * THE ACTUAL IS A RAW PER-ACCOUNT GL AGGREGATE, DELIBERATELY NOT THE INCOME
 * STATEMENT. `incomeStatementService` has open defects in exactly the layer a
 * variance would inherit — a rolling-window comparative, cost of sales bucketed
 * by account NAME rather than subtype, and no other-income / finance-cost / tax
 * layer at all. Summing posted journal lines per account borrows none of that:
 * it is the same figure the trial balance shows for the account.
 *
 * Signs are normalised so "more is more" on both sides: revenue is credit less
 * debit, expenses are debit less credit. The variance rules themselves live in
 * budgetVsActualLines so this and the Budget vs Actual report cannot drift.
 *
 * Two modes (the lead's ruling, PR-C):
 *   - DEFAULT (no `partialWindow`): P0's rule. The window budget is the sum of
 *     every budgeted month in it, across as many years as it spans, even when
 *     a year has no budget or a line is budgeted in only some years. The result
 *     is P0's shape with NO added field, so MCP budget_variance and the packs
 *     answer byte for byte as before.
 *   - `partialWindow: 'absent'` (the statement comparator): the engine's rule,
 *     as Budget vs Actual prints it, mapped by `budgetVarianceTracked` (every
 *     verdict copied from the engine). Only this mode takes a dimension filter
 *     or a version, and a range that splits a budget month has no window
 *     budget in it.
 */

import { round2 } from '../core/budgetMonths';
import { fromCents, toCents } from '../budgets/grid/cents';
import { buildRangeTracking, type RangeTrackingOptions } from '../budgets/tracking/trackingRange';
import type { TrackingLine } from '../budgets/tracking/trackingTypes';
import { buildBudgetVsActualLines, type BudgetVsActualLine, type RawActualRow } from './budgetVsActualLines';
import { buildBudgetVsActualSections, type BudgetVsActualSections } from './budgetVsActualSections';
import { trackedVariance, type BudgetVarianceTracked } from './budgetVarianceTracked';

/** The engine's rule, a filter and a version: the statement comparator's mode. */
export type BudgetVarianceTrackedOptions = Omit<RangeTrackingOptions, 'wholeMonthsOnly'> & { partialWindow: 'absent' };

/** P0's rule (the default): no filter, no version, the partial-window sum. */
export type BudgetVarianceOptions = { partialWindow?: 'sum' } | BudgetVarianceTrackedOptions;

export interface BudgetVarianceResult {
  /** The financial year (registry label) holding the window's start. */
  fiscalYear: number;
  /** The 'YYYY-MM' calendar months the budget was summed over, in window order. */
  monthKeys: string[];
  /** Every line the report prints: budgeted, or carrying movement. */
  lines: BudgetVsActualLine[];
  /** Accounts that carry a budget for this window, a deliberate zero included. */
  rows: BudgetVsActualLine[];
  /** Accounts with real posted movement and no budget at all. */
  unbudgeted: BudgetVsActualLine[];
  /** Revenue / Expenses / Net profit over `lines`. */
  sections: BudgetVsActualSections;
  /** Budgeted + unbudgeted — every account this report had to classify. */
  universeTotal: number;
  /** Net profit (budget, actual, favourably signed variance) — not revenue + expense, which means nothing. */
  totals: { budget: number; actual: number; variance: number };
  /** Absolute value of movement on accounts nobody budgeted. */
  unbudgetedMovement: number;
  /** Latest posted entry date inside the window, or null when nothing posted. */
  postedThrough: string | null;
}

/** `partialWindow: 'absent'` only: P0's identification fields beside the engine's view of the window. */
export type BudgetVarianceTrackedResult = Pick<BudgetVarianceResult, 'fiscalYear' | 'monthKeys' | 'postedThrough'> & BudgetVarianceTracked;

/** P0's window budget: every budgeted month of the window summed, null when none is (integer cents, as the engine sums). */
function summedBudget(line: TrackingLine): number | null {
  const months = line.monthly.filter((m) => m.budget !== null);
  return months.length === 0 ? null : fromCents(months.reduce((c, m) => c + toCents(m.budget!), 0));
}

const FILTER_KEYS = ['versionId', 'cc1Id', 'cc2Id', 'buId', 'costCentreId'] as const;

export function getBudgetVariance(
  companyId: string, periodStart: string, periodEnd: string, opts: BudgetVarianceTrackedOptions,
): Promise<BudgetVarianceTrackedResult>;
export function getBudgetVariance(
  companyId: string, periodStart: string, periodEnd: string, opts?: { partialWindow?: 'sum' },
): Promise<BudgetVarianceResult>;
export async function getBudgetVariance(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  opts: BudgetVarianceOptions = {},
): Promise<BudgetVarianceResult | BudgetVarianceTrackedResult> {
  if (opts.partialWindow === 'absent') {
    const { partialWindow: _mode, ...filter } = opts;
    const range = await buildRangeTracking(companyId, periodStart, periodEnd, { ...filter, wholeMonthsOnly: true });
    return { fiscalYear: range.startFiscalYear, monthKeys: range.months, postedThrough: range.postedThrough, ...trackedVariance(range) };
  }
  // A filter or a version under P0's rule would hide budget set above the filter with nobody told: refused.
  const stray = FILTER_KEYS.filter((k) => (opts as Record<string, unknown>)[k] !== undefined);
  if (stray.length > 0) throw new Error(`getBudgetVariance: ${stray.join(', ')} needs partialWindow 'absent'`);

  const range = await buildRangeTracking(companyId, periodStart, periodEnd);
  // The engine's figures, through P0's own row builder (variance, %, favourable, the keep rule).
  const actuals: RawActualRow[] = range.lines.map((l) => ({
    id: l.accountId, account_code: l.accountCode, account_name: l.accountName, account_type: l.accountType, actual_amount: l.actual,
  }));
  const budgets: Record<string, number> = {};
  for (const l of range.lines) {
    const b = summedBudget(l);
    if (b !== null) budgets[l.accountId] = b;
  }
  const lines = buildBudgetVsActualLines(actuals, budgets);
  // Split on the budgeted BIT, never on the amount: a deliberate zero budget is a budget (D5).
  const rows = lines.filter((l) => l.budgeted);
  const unbudgeted = lines.filter((l) => !l.budgeted);
  const sections = buildBudgetVsActualSections(lines);
  return {
    fiscalYear: range.startFiscalYear,
    monthKeys: range.months,
    lines,
    rows,
    unbudgeted,
    sections,
    universeTotal: lines.length,
    totals: {
      budget: sections.net_profit.budget,
      actual: sections.net_profit.actual,
      variance: sections.net_profit.variance,
    },
    unbudgetedMovement: round2(
      unbudgeted.reduce((s, l) => s + Math.abs(l.actual_amount), 0),
    ),
    postedThrough: range.postedThrough,
  };
}
