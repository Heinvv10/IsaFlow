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
 */
import { fromCents, toCents } from '../grid/cents';
import { BAND_LABEL, BAND_ORDER, BAND_SIGN } from '../grid/subtotals';
import { isFavourable, pctOf } from './trackingLines';
import type { ByPolarity, TrackingBand, TrackingBandKey, TrackingLine, TrackingNotices, TrackingTotalKey } from './trackingTypes';

/** The grid's bands (`budgets/grid/subtotals.ts`): one key set, label and sign for every budget surface. */
const BANDS = BAND_ORDER.map((key) => ({ key, label: BAND_LABEL[key], polarity: BAND_SIGN[key] === 1 ? 'income' as const : 'expense' as const }));

/** Cents, with null = absent. */
/** Cents, with null = absent. `partial`: a line under it budgets only part of the window (G1). */
interface Sums { actual: number; budget: number | null; projected: number; fyBudget: number | null; unallocated: number | null; partial: boolean }

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
  };
}

function figures(
  key: TrackingBand['key'], label: string, kind: TrackingBand['kind'], polarity: 'income' | 'expense', s: Sums,
): TrackingBand {
  const variance = s.budget === null ? null : s.actual - s.budget;
  const projVariance = s.fyBudget === null ? null : s.projected - s.fyBudget;
  return {
    key, label, kind, polarity,
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

/** The eight bands and totals, in statement order. */
export function buildBands(lines: readonly TrackingLine[], opts: { budgetAbsent?: boolean } = {}): TrackingBand[] {
  // Unallocated budget is absent on EVERY band once the window budget is (lines carry null then, A2).
  // From the window too (review r3 R1): a gap window with no lines has nothing to read it from.
  const unallocatedAbsent = opts.budgetAbsent === true || lines.some((l) => l.unallocatedBudget === null);
  const sums = new Map(BANDS.map((b) => [b.key, sumLines(lines.filter((l) => l.band === b.key), unallocatedAbsent)]));
  const band = (key: TrackingBandKey) => {
    const def = BANDS.find((b) => b.key === key)!;
    return figures(key, def.label, 'band', def.polarity, sums.get(key)!);
  };
  const s = (key: TrackingBandKey) => sums.get(key)!;
  const gross = combine(s('turnover'), s('cost_of_sales'), 'minus');
  const operating = combine(combine(gross, s('other_income'), 'plus'), s('operating_expense'), 'minus');
  const net = combine(operating, s('other_expense'), 'minus');
  // A profit total over a line that budgets only part of the window is a partial-window figure: its
  // budget is absent (review r5 G1), so no bridge is drawn from it.
  const total = (key: TrackingTotalKey, label: string, kind: 'total' | 'grand', x: Sums) =>
    figures(key, label, kind, 'income', x.partial ? { ...x, budget: null } : x);
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
 * The notices under the table. "Unbudgeted" is an account with posted movement, no included
 * budget and no budget above the filter either (that one is the unallocated footer's). With the
 * window budget absent (a year without a version) nothing is called unbudgeted: the no-version
 * notice is the reason. Every figure is kept per polarity.
 */
export function buildNotices(
  lines: readonly TrackingLine[],
  v: { noVersion: boolean; noVersionYears: number[]; budgetAbsent: boolean },
): TrackingNotices {
  const unbudgeted = v.budgetAbsent ? [] : lines.filter((l) => l.budget === null && !l.budgetAboveFilter && !l.partialBudget && l.actual !== 0);
  const split = (ls: readonly TrackingLine[], pick: (l: TrackingLine) => number): ByPolarity => ({
    income: fromCents(ls.filter((l) => l.accountType === 'revenue').reduce((s, l) => s + toCents(pick(l)), 0)),
    expense: fromCents(ls.filter((l) => l.accountType === 'expense').reduce((s, l) => s + toCents(pick(l)), 0)),
  });
  return {
    unbudgetedCount: unbudgeted.length,
    unbudgetedActual: split(unbudgeted, (l) => l.actual),
    unallocatedBudget: v.budgetAbsent ? null : split(lines, (l) => l.unallocatedBudget ?? 0),
    noVersion: v.noVersion,
    noVersionYears: v.noVersionYears,
  };
}
