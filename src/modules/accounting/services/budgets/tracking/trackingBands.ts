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
 * A band's budget is Σ its lines' budgets with an unbudgeted line counting 0
 * (its actual then sits inside the band variance: the notice names it); a
 * band with NO budgeted line is absent (null), never zero. Unallocated budget
 * on a profit total is netted by polarity the same way. A profit total is
 * absent only when every band under it is. The same rules hold for the
 * projection's FY budget. Favourable: income bands up, expense bands down,
 * profit totals up.
 *
 * A band with NO budget at the filter because its budget sits ABOVE it (a line whose verdict is
 * `above-filter`) is not an empty band: a profit total netting it has no budget either (review r2,
 * R9), never the other side's budget alone. A band with no budgeted line and no such line (empty, or
 * only unbudgeted accounts, which the notice names) still counts 0.
 */
import { fromCents, toCents } from '../grid/cents';
import { BAND_LABEL, BAND_ORDER, BAND_SIGN } from '../grid/subtotals';
import { isFavourable, pctOf } from './trackingLines';
import type { ByPolarity, TrackingBand, TrackingBandKey, TrackingLine, TrackingNotices, TrackingTotalKey } from './trackingTypes';

/** The grid's bands (`budgets/grid/subtotals.ts`): one key set, label and sign for every budget surface. */
const BANDS = BAND_ORDER.map((key) => ({ key, label: BAND_LABEL[key], polarity: BAND_SIGN[key] === 1 ? 'income' as const : 'expense' as const }));

/** Cents, with null = absent. */
/** Cents, with null = absent. `partial`: a line under it budgets only part of the window (G1). */
interface Sums {
  actual: number; budget: number | null; projected: number; fyBudget: number | null; unallocated: number | null; partial: boolean;
  /** No budget at the filter because it sits above it: a profit total netting this has no budget (R9). */
  hidden: boolean;
}

const plus = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
const minus = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) - (y ?? 0));

function sumLines(lines: readonly TrackingLine[], unallocatedAbsent: boolean): Sums {
  const cents = (v: number | null) => (v === null ? 0 : toCents(v));
  return {
    actual: lines.reduce((s, l) => s + toCents(l.actual), 0),
    budget: lines.some((l) => l.budget !== null) ? lines.reduce((s, l) => s + cents(l.budget), 0) : null,
    projected: lines.reduce((s, l) => s + toCents(l.projected), 0),
    fyBudget: lines.some((l) => l.fyBudget !== null) ? lines.reduce((s, l) => s + cents(l.fyBudget), 0) : null,
    unallocated: unallocatedAbsent ? null : lines.reduce((s, l) => s + cents(l.unallocatedBudget), 0),
    partial: lines.some((l) => l.partialBudget),
    hidden: !lines.some((l) => l.budget !== null) && lines.some((l) => l.budgetVerdict === 'above-filter'),
  };
}

function combine(x: Sums, y: Sums, op: 'plus' | 'minus'): Sums {
  const f = op === 'plus' ? plus : minus;
  return {
    actual: op === 'plus' ? x.actual + y.actual : x.actual - y.actual,
    budget: f(x.budget, y.budget),
    projected: op === 'plus' ? x.projected + y.projected : x.projected - y.projected,
    fyBudget: f(x.fyBudget, y.fyBudget),
    // Netted by polarity like the budget (D1: never income + expense).
    unallocated: f(x.unallocated, y.unallocated),
    partial: x.partial || y.partial,
    hidden: x.hidden || y.hidden,
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

// A band holding a line that budgets only part of the window has a partial-window budget too:
// absent, like the totals above it (review r6 F2). A band whose lines are whole keeps its own. A
// band whose only budget sits above the filter is absent as well (review r2, R9).
const whole = (x: Sums): Sums => (x.partial || x.hidden ? { ...x, budget: null } : x);

/** The eight bands and totals, in statement order. */
export function buildBands(lines: readonly TrackingLine[], opts: { budgetAbsent?: boolean } = {}): TrackingBand[] {
  const sums = bandSums(lines, opts.budgetAbsent === true);
  const band = (key: TrackingBandKey) => {
    const def = BANDS.find((b) => b.key === key)!;
    return figures(key, def.label, 'band', def.polarity, whole(sums.get(key)!));
  };
  const s = (key: TrackingBandKey) => sums.get(key)!;
  const gross = combine(s('turnover'), s('cost_of_sales'), 'minus');
  const operating = combine(combine(gross, s('other_income'), 'plus'), s('operating_expense'), 'minus');
  const net = combine(operating, s('other_expense'), 'minus');
  // A profit total over a line that budgets only part of the window is a partial-window figure: its
  // budget is absent (review r5 G1), so no bridge is drawn from it.
  const total = (key: TrackingTotalKey, label: string, kind: 'total' | 'grand', x: Sums) =>
    figures(key, label, kind, 'income', whole(x));
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
 * them, null where a band under them is partial or has its budget above the filter, or the window
 * budget is absent (review r2, LB2-1): never a sum of the lines that happen to be budgeted, and
 * never a zero nobody set. Net profit is the engine's own net-profit band.
 */
export function sectionBudgets(
  lines: readonly TrackingLine[], opts: { budgetAbsent?: boolean } = {},
): { revenue: number | null; expense: number | null; net_profit: number | null } {
  const sums = bandSums(lines, opts.budgetAbsent === true);
  const s = (key: TrackingBandKey) => sums.get(key)!;
  const budgetOf = (x: Sums): number | null => { const b = whole(x).budget; return b === null ? null : fromCents(b); };
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
