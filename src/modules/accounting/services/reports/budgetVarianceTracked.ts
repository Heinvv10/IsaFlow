/**
 * `getBudgetVariance(…, { partialWindow: 'absent' })`: the tracking engine's
 * view of a date range in P0's line shape, for the statement comparator
 * (budgets P3 PR-C, the lead's R3/R4/R7 rulings). Everything the engine
 * decides is COPIED, never re-derived:
 *   - each line's `budget_verdict` (and `budget_partial` for a partial one) is
 *     the engine line's `budgetVerdict`; only a `budgeted` line carries a
 *     budget, and only an `unbudgeted` one is in `unbudgeted`;
 *   - `bands` are the engine's band and profit-total budgets (null when a line
 *     under them is partial, or the window budget is absent): the comparator
 *     prints them on the statement's band rows, never a sum of withheld lines;
 *   - a section or net profit whose engine bands are partial, or whose window
 *     budget is absent, has NO budget (null), never the sum of the lines that
 *     happen to be budgeted;
 *   - the partial count is the engine's (every partial account, with or
 *     without an actual), and so are the absent years and unallocated budget.
 */
import { round2 } from '../core/budgetMonths';
import type { RangeTracking } from '../budgets/tracking/trackingRange';
import type {
  BudgetVerdict, ByPolarity, TrackingBandKey, TrackingTotalKey, TrackingVersionRef,
} from '../budgets/tracking/trackingTypes';
import { buildBudgetVsActualLines, type BudgetVsActualLine, type RawActualRow } from './budgetVsActualLines';
import { buildBudgetVsActualSections, type BudgetSectionKey, type BudgetVsActualSection } from './budgetVsActualSections';

export interface TrackedLine extends BudgetVsActualLine {
  budget_verdict: BudgetVerdict;
  /** The engine band the account sits in (where the statement prints it). */
  band: TrackingBandKey;
}

type Judged = 'budget' | 'variance' | 'movement' | 'variance_pct' | 'movement_pct' | 'favourable';
/** A P0 section whose budget may be absent: every budget-derived figure is then null. */
export type TrackedSection = Omit<BudgetVsActualSection, Judged> & {
  budget: number | null; variance: number | null; movement: number | null;
  variance_pct: number | null; movement_pct: number | null; favourable: boolean | null;
};

export interface BudgetVarianceTracked {
  lines: TrackedLine[];
  rows: TrackedLine[];
  unbudgeted: TrackedLine[];
  sections: Record<BudgetSectionKey, TrackedSection>;
  totals: { budget: number | null; actual: number; variance: number | null };
  universeTotal: number;
  unbudgetedMovement: number;
  /** Years in the window with no budget in it. */
  budgetAbsentYears: number[];
  /** Every financial year with months in the window, in order. */
  windowYears: number[];
  /** The range cuts a budget month: the window budget is absent ("Budgets are set by whole month"). */
  splitsMonth: boolean;
  version: TrackingVersionRef | null;
  unallocatedBudget: ByPolarity | null;
  /** The engine's count of accounts budgeted for only part of the window. */
  partialBudgetCount: number;
  bands: Array<{ key: TrackingBandKey | TrackingTotalKey; budget: number | null }>;
}

const SECTION_BANDS: Record<BudgetSectionKey, ReadonlyArray<TrackingBandKey | TrackingTotalKey>> = {
  revenue: ['turnover', 'other_income'],
  expense: ['cost_of_sales', 'operating_expense', 'other_expense'],
  net_profit: ['net_profit'],
};

function withheldSection(s: BudgetVsActualSection): TrackedSection {
  return { ...s, budget: null, variance: null, movement: null, variance_pct: null, movement_pct: null, favourable: null };
}

export function trackedVariance(range: RangeTracking): BudgetVarianceTracked {
  const engine = new Map(range.lines.map((l) => [l.accountId, l]));
  const actuals: RawActualRow[] = range.lines.map((l) => ({
    id: l.accountId, account_code: l.accountCode, account_name: l.accountName, account_type: l.accountType, actual_amount: l.actual,
  }));
  const budgets: Record<string, number> = {};
  for (const l of range.lines) if (l.budgetVerdict === 'budgeted' && l.budget !== null) budgets[l.accountId] = l.budget;
  const lines: TrackedLine[] = buildBudgetVsActualLines(actuals, budgets).map((l) => {
    const e = engine.get(l.account_id)!;
    const out: TrackedLine = { ...l, budget_verdict: e.budgetVerdict, band: e.band };
    if (e.budgetVerdict === 'partial') out.budget_partial = true;
    return out;
  });
  const rows = lines.filter((l) => l.budget_verdict === 'budgeted');
  const unbudgeted = lines.filter((l) => l.budget_verdict === 'unbudgeted');

  const partialBand = new Set(range.bands.filter((b) => b.partialBudget).map((b) => b.key));
  const p0 = buildBudgetVsActualSections(lines);
  const section = (key: BudgetSectionKey): TrackedSection =>
    (range.budgetAbsent || SECTION_BANDS[key].some((k) => partialBand.has(k)) ? withheldSection(p0[key]) : p0[key]);
  const sections = { revenue: section('revenue'), expense: section('expense'), net_profit: section('net_profit') };

  return {
    lines,
    rows,
    unbudgeted,
    sections,
    totals: { budget: sections.net_profit.budget, actual: sections.net_profit.actual, variance: sections.net_profit.variance },
    universeTotal: lines.length,
    unbudgetedMovement: round2(unbudgeted.reduce((s, l) => s + Math.abs(l.actual_amount), 0)),
    budgetAbsentYears: range.notices.noVersionYears,
    windowYears: range.years.filter((y) => y.months.length > 0).map((y) => y.fiscalYear),
    splitsMonth: range.splitsMonth,
    version: range.version,
    unallocatedBudget: range.notices.unallocatedBudget,
    partialBudgetCount: range.notices.partialBudget?.count ?? 0,
    bands: range.bands.map((b) => ({ key: b.key, budget: b.budget })),
  };
}
