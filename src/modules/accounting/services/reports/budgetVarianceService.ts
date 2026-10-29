/**
 * Budget variance: what was planned against what the ledger actually carries.
 *
 * A FACADE over the budgets P3 tracking engine (spec §3, PR-C). The figures
 * are `budgets/tracking/trackingRange.ts`'s: the engine's one actuals SQL
 * (`trackingActualRead`), its budget read, its dimension classes and its
 * budget-absent and partial rules. This file only maps them onto P0's
 * `BudgetVarianceResult`, which its consumers (the statement comparator, MCP
 * budget_variance, the board pack, the old Budget vs Actual routes) read.
 * With no options the P0 fields are deep-equal to the pre-facade service's
 * wherever P0 and the engine agree (tests/integration/budget-variance-facade-parity.int.test.ts,
 * whose oracle is P0's own SQL).
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
 * A line whose budget the engine WITHHOLDS (a year in the range with no budget
 * in it, a budget for only part of the range, or one set above the filter) is
 * neither budgeted nor unbudgeted: it is in `lines` with `budgeted: false` and
 * in neither `rows` nor `unbudgeted`, and `noBudgetYears` / `unallocatedBudget`
 * say why. Calling it unbudgeted would state that nobody set a budget.
 */

import { round2 } from '../core/budgetMonths';
import { buildRangeTracking, type RangeTrackingOptions } from '../budgets/tracking/trackingRange';
import type { ByPolarity, TrackingLine, TrackingVersionRef } from '../budgets/tracking/trackingTypes';
import { buildBudgetVsActualLines, type BudgetVsActualLine, type RawActualRow } from './budgetVsActualLines';
import { buildBudgetVsActualSections, type BudgetVsActualSections } from './budgetVsActualSections';
import { fiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearRegistry';

export type BudgetVarianceOptions = RangeTrackingOptions;

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
  /** Budgeted + unbudgeted + withheld — every account this report had to classify. */
  universeTotal: number;
  /** Net profit (budget, actual, favourably signed variance) — not revenue + expense, which means nothing. */
  totals: { budget: number; actual: number; variance: number };
  /** Absolute value of movement on accounts nobody budgeted. */
  unbudgetedMovement: number;
  /** Latest posted entry date inside the window, or null when nothing posted. */
  postedThrough: string | null;
  /** The version of the year holding the window's end (`empty`: it holds no budget in the window); null when that year has none. */
  version: TrackingVersionRef | null;
  /** Budget set above the dimension filter, never apportioned, per polarity; null when the window budget is absent. */
  unallocatedBudget: ByPolarity | null;
  /** Years in the window with no budget in it: while any is listed, no line carries a window budget. */
  noBudgetYears: number[];
  /** Accounts budgeted for only part of the window (some of its years, or a grain change): their budget is withheld. */
  partialBudgetCount: number;
}

/** The engine has a budget for the account in a window month that it does not print as the window's. */
function withheld(line: TrackingLine): boolean {
  return line.budget === null && (line.partialBudget || line.budgetAboveFilter || line.monthly.some((m) => m.budget !== null));
}

export async function getBudgetVariance(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  opts: BudgetVarianceOptions = {},
): Promise<BudgetVarianceResult> {
  // The financial year holding the window's start: a label for the reader to
  // re-derive against, not a key the budget is looked up by (budgets are per
  // calendar month, so a window spanning two years sums both).
  const fiscalYear = (await fiscalYearForDate(companyId, periodStart)).fiscalYear;
  const range = await buildRangeTracking(companyId, periodStart, periodEnd, opts);

  // The engine's figures, through P0's own row builder (variance, %, favourable, the keep rule).
  const actuals: RawActualRow[] = range.lines.map((l) => ({
    id: l.accountId, account_code: l.accountCode, account_name: l.accountName, account_type: l.accountType, actual_amount: l.actual,
  }));
  const budgets: Record<string, number> = {};
  for (const l of range.lines) if (l.budget !== null) budgets[l.accountId] = l.budget;
  const lines = buildBudgetVsActualLines(actuals, budgets);
  const held = new Set(range.lines.filter(withheld).map((l) => l.accountId));
  // Split on the budgeted BIT, never on the amount: a deliberate zero budget is a budget (D5).
  const rows = lines.filter((l) => l.budgeted);
  const unbudgeted = lines.filter((l) => !l.budgeted && !held.has(l.account_id));
  const sections = buildBudgetVsActualSections(lines);

  return {
    fiscalYear,
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
    version: range.version,
    unallocatedBudget: range.notices.unallocatedBudget,
    noBudgetYears: range.notices.noVersionYears,
    partialBudgetCount: range.notices.partialBudget?.count ?? 0,
  };
}
