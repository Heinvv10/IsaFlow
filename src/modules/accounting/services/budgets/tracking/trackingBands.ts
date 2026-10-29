/**
 * The income-statement bands of the tracking report (budgets P3 spec §2.1).
 * Pure. Computed HERE, in the engine, so the `statementRows/` adapter only
 * copies ("copy, never derive").
 *
 * Order and arithmetic are `incomeStatementService`'s: Turnover, Cost of
 * Sales, Gross Profit (= Turnover − COS), Other Income, Operating Expenses,
 * Operating Profit (= GP + Other Income − Opex), Other Expenses, Net Profit
 * (= OP − Other Expenses). There is no revenue + expense total (D1).
 *
 * The rule for a budget that is netted (review r3, the lead's FINAL R9 ruling), the same for the
 * window budget and the projection's FY budget, on the comparator and on Budget vs Actual:
 *   - a band's budget is NULL when a line in it is partial, when a line's budget sits only above the
 *     filter (strict, never apportioned), or when the band has lines and none of them has a budget;
 *   - an unbudgeted line inside a band that has a budgeted line counts 0, and a band with no lines
 *     counts 0 (it shows no budget of its own);
 *   - a profit total (gross, operating, net), and a P0 section, is NULL when any band it nets is
 *     NULL: never one side's budget alone. When every band it nets has no lines it is absent too.
 * The cost is deliberate: under a filter, Net Profit is "—" whenever a band is budgeted above the
 * filter (company-level overheads, say) or holds an account with no budget. Unallocated budget on a
 * profit total is netted by polarity. Favourable: income bands up, expense bands down, profit totals up.
 */
import { fromCents, toCents } from '../grid/cents';
import { BAND_LABEL, BAND_ORDER, BAND_SIGN } from '../grid/subtotals';
import { isFavourable, pctOf } from './trackingLines';
import type { ByPolarity, TrackingBand, TrackingBandKey, TrackingLine, TrackingNotices, TrackingTotalKey } from './trackingTypes';

/** The grid's bands (`budgets/grid/subtotals.ts`): one key set, label and sign for every budget surface. */
const BANDS = BAND_ORDER.map((key) => ({ key, label: BAND_LABEL[key], polarity: BAND_SIGN[key] === 1 ? 'income' as const : 'expense' as const }));

/**
 * Cents. `budget` / `fyBudget`: null = absent. `blocked`: the budget is NULL for a reason that makes a
 * profit total netting it NULL too (see the header); `empty`: no lines at all, so it counts 0 and shows none.
 * `partial`: a line under it budgets only part of the window (G1).
 */
interface Sums {
  actual: number; projected: number; unallocated: number | null; partial: boolean;
  budget: number | null; budgetBlocked: boolean;
  fyBudget: number | null; fyBlocked: boolean;
  empty: boolean; fyEmpty: boolean;
}

const plus = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
const minus = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) - (y ?? 0));

/**
 * A line that says something about the band's WINDOW budget: it has an actual, a budget, a partial budget or
 * one above the filter. The report keeps other lines only for the projection (an FY budget with no window
 * figure); they must not turn a band with no budget into "a band with lines", or the two pages (the report
 * keeps them, the range does not) would disagree.
 */
const speaks = (l: TrackingLine): boolean => l.actual !== 0 || l.budget !== null || l.partialBudget || l.budgetVerdict === 'above-filter';

function sumLines(lines: readonly TrackingLine[], unallocatedAbsent: boolean): Sums {
  const cents = (v: number | null) => (v === null ? 0 : toCents(v));
  const win = lines.filter(speaks);
  const fy = lines.filter((l) => speaks(l) || l.fyBudget !== null);
  const partial = lines.some((l) => l.partialBudget);
  const above = lines.some((l) => l.budgetVerdict === 'above-filter');
  const budgetBlocked = partial || above || (win.length > 0 && !win.some((l) => l.budget !== null));
  const fyBlocked = partial || above || (fy.length > 0 && !fy.some((l) => l.fyBudget !== null));
  return {
    actual: lines.reduce((s, l) => s + toCents(l.actual), 0),
    projected: lines.reduce((s, l) => s + toCents(l.projected), 0),
    unallocated: unallocatedAbsent ? null : lines.reduce((s, l) => s + cents(l.unallocatedBudget), 0),
    partial,
    budget: budgetBlocked || win.length === 0 ? null : win.reduce((s, l) => s + cents(l.budget), 0),
    budgetBlocked,
    fyBudget: fyBlocked || fy.length === 0 ? null : fy.reduce((s, l) => s + cents(l.fyBudget), 0),
    fyBlocked,
    empty: win.length === 0,
    fyEmpty: fy.length === 0,
  };
}

/** x ± y for a netted budget: NULL when either side is blocked; an empty side counts 0; both empty is absent. */
function net(
  x: { v: number | null; blocked: boolean; empty: boolean }, y: { v: number | null; blocked: boolean; empty: boolean }, op: 'plus' | 'minus',
): { v: number | null; blocked: boolean; empty: boolean } {
  if (x.blocked || y.blocked) return { v: null, blocked: true, empty: false };
  if (x.empty && y.empty) return { v: null, blocked: false, empty: true };
  const a = x.v ?? 0;
  const b = y.v ?? 0;
  return { v: op === 'plus' ? a + b : a - b, blocked: false, empty: false };
}

function combine(x: Sums, y: Sums, op: 'plus' | 'minus'): Sums {
  const f = op === 'plus' ? plus : minus;
  const w = net({ v: x.budget, blocked: x.budgetBlocked, empty: x.empty }, { v: y.budget, blocked: y.budgetBlocked, empty: y.empty }, op);
  const fy = net({ v: x.fyBudget, blocked: x.fyBlocked, empty: x.fyEmpty }, { v: y.fyBudget, blocked: y.fyBlocked, empty: y.fyEmpty }, op);
  return {
    actual: op === 'plus' ? x.actual + y.actual : x.actual - y.actual,
    projected: op === 'plus' ? x.projected + y.projected : x.projected - y.projected,
    // Netted by polarity (D1: never income + expense); null-tolerant, it is a footer figure, not a target.
    unallocated: f(x.unallocated, y.unallocated),
    partial: x.partial || y.partial,
    budget: w.v, budgetBlocked: w.blocked,
    fyBudget: fy.v, fyBlocked: fy.blocked,
    empty: w.empty, fyEmpty: fy.empty,
  };
}

function figures(
  key: TrackingBand['key'], label: string, kind: TrackingBand['kind'], polarity: 'income' | 'expense', s: Sums,
): TrackingBand {
  const variance = s.budget === null ? null : s.actual - s.budget;
  const projVariance = s.fyBudget === null ? null : s.projected - s.fyBudget;
  return {
    key, label, kind, polarity, partialBudget: s.partial,
    actual: fromCents(s.actual),
    budget: s.budget === null ? null : fromCents(s.budget),
    variance: variance === null ? null : fromCents(variance),
    variancePct: variance === null ? null : pctOf(variance, s.budget),
    favourable: variance === null ? null : isFavourable(polarity, variance),
    projected: fromCents(s.projected),
    fyBudget: s.fyBudget === null ? null : fromCents(s.fyBudget),
    projVariance: projVariance === null ? null : fromCents(projVariance),
    projFavourable: projVariance === null ? null : isFavourable(polarity, projVariance),
    unallocatedBudget: s.unallocated === null ? null : fromCents(s.unallocated),
  };
}

/** Each band's sums over its lines; unallocated budget is absent on every band once the window budget is. */
function bandSums(lines: readonly TrackingLine[], budgetAbsent: boolean): Map<TrackingBandKey, Sums> {
  // Unallocated budget is absent on EVERY band once the window budget is (lines carry null then, A2).
  // From the window too (review r3 R1): a gap window with no lines has nothing to read it from.
  const unallocatedAbsent = budgetAbsent || lines.some((l) => l.unallocatedBudget === null);
  return new Map(BANDS.map((b) => [b.key, sumLines(lines.filter((l) => l.band === b.key), unallocatedAbsent)]));
}

/** The eight bands and totals, in statement order. */
export function buildBands(lines: readonly TrackingLine[], opts: { budgetAbsent?: boolean } = {}): TrackingBand[] {
  const sums = bandSums(lines, opts.budgetAbsent === true);
  const band = (key: TrackingBandKey) => {
    const def = BANDS.find((b) => b.key === key)!;
    return figures(key, def.label, 'band', def.polarity, sums.get(key)!);
  };
  const s = (key: TrackingBandKey) => sums.get(key)!;
  const gross = combine(s('turnover'), s('cost_of_sales'), 'minus');
  const operating = combine(combine(gross, s('other_income'), 'plus'), s('operating_expense'), 'minus');
  const net = combine(operating, s('other_expense'), 'minus');
  // A profit total netting a null band is null (the header's rule), so no bridge is drawn from it.
  const total = (key: TrackingTotalKey, label: string, kind: 'total' | 'grand', x: Sums) =>
    figures(key, label, kind, 'income', x);
  return [
    band('turnover'),
    band('cost_of_sales'),
    total('gross_profit', 'Gross Profit', 'total', gross),
    band('other_income'),
    band('operating_expense'),
    total('operating_profit', 'Operating Profit', 'total', operating),
    band('other_expense'),
    total('net_profit', 'Net Profit / (Loss)', 'grand', net),
  ];
}

/**
 * The budgets of P0's three sections (revenue, expenses, net profit) as the ENGINE's bands give
 * them, null where any band under them is null by the header's rule (partial, above the filter,
 * lines with no budget) or the window budget is absent (review r2 LB2-1, r3 R9): never a sum of the
 * lines that happen to be budgeted, and never a zero nobody set. Net profit is the engine's own band.
 */
export function sectionBudgets(
  lines: readonly TrackingLine[], opts: { budgetAbsent?: boolean } = {},
): { revenue: number | null; expense: number | null; net_profit: number | null } {
  const sums = bandSums(lines, opts.budgetAbsent === true);
  const s = (key: TrackingBandKey) => sums.get(key)!;
  const budgetOf = (x: Sums): number | null => (x.budget === null ? null : fromCents(x.budget));
  const revenue = combine(s('turnover'), s('other_income'), 'plus');
  const expense = combine(combine(s('cost_of_sales'), s('operating_expense'), 'plus'), s('other_expense'), 'plus');
  const gross = combine(s('turnover'), s('cost_of_sales'), 'minus');
  const net = combine(combine(combine(gross, s('other_income'), 'plus'), s('operating_expense'), 'minus'), s('other_expense'), 'minus');
  return { revenue: budgetOf(revenue), expense: budgetOf(expense), net_profit: budgetOf(net) };
}

/**
 * The notices under the table. "Unbudgeted" is an account with posted movement, no included
 * budget and no budget above the filter either (that one is the unallocated footer's). With the
 * window budget absent (a year without a version) nothing is called unbudgeted: the no-version
 * notice is the reason. The lines whose budget covers only part of the window are counted in
 * `partialBudget` (their actual per polarity), so a blank Budget is explained. Every figure is kept
 * per polarity.
 */
export function buildNotices(
  lines: readonly TrackingLine[],
  v: { noVersion: boolean; noVersionYears: number[]; budgetAbsent: boolean; outsideFilterYears?: number[] },
): TrackingNotices {
  // The lines' own verdicts: under an absent window budget every line is 'absent', so none is unbudgeted.
  const unbudgeted = lines.filter((l) => l.budgetVerdict === 'unbudgeted' && l.actual !== 0);
  const split = (ls: readonly TrackingLine[], pick: (l: TrackingLine) => number): ByPolarity => ({
    income: fromCents(ls.filter((l) => l.accountType === 'revenue').reduce((s, l) => s + toCents(pick(l)), 0)),
    expense: fromCents(ls.filter((l) => l.accountType === 'expense').reduce((s, l) => s + toCents(pick(l)), 0)),
  });
  const partial = lines.filter((l) => l.budgetVerdict === 'partial');
  return {
    unbudgetedCount: unbudgeted.length,
    unbudgetedActual: split(unbudgeted, (l) => l.actual),
    unallocatedBudget: v.budgetAbsent ? null : split(lines, (l) => l.unallocatedBudget ?? 0),
    noVersion: v.noVersion,
    noVersionYears: v.noVersionYears,
    noBudgetAtFilterYears: v.budgetAbsent ? [] : v.outsideFilterYears ?? [],
    partialBudget: partial.length === 0 ? null : { count: partial.length, actual: split(partial, (l) => l.actual) },
  };
}
