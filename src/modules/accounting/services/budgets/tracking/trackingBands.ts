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
 * band with NO budgeted line is absent (null), never zero. A profit total is
 * absent only when every band under it is. The same rules hold for the
 * projection's FY budget. Favourable: income bands up, expense bands down,
 * profit totals up.
 */
import { fromCents, toCents } from '../grid/cents';
import { BAND_LABEL, BAND_ORDER, BAND_SIGN } from '../grid/subtotals';
import { isFavourable, pctOf } from './trackingLines';
import type { TrackingBand, TrackingBandKey, TrackingLine, TrackingTotalKey } from './trackingTypes';

/** The grid's bands (`budgets/grid/subtotals.ts`): one key set, label and sign for every budget surface. */
const BANDS = BAND_ORDER.map((key) => ({ key, label: BAND_LABEL[key], polarity: BAND_SIGN[key] === 1 ? 'income' as const : 'expense' as const }));

/** Cents, with null = absent. */
interface Sums { actual: number; budget: number | null; projected: number; fyBudget: number | null; unallocated: number }

const plus = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
const minus = (x: number | null, y: number | null): number | null => (x === null && y === null ? null : (x ?? 0) - (y ?? 0));

function sumLines(lines: readonly TrackingLine[]): Sums {
  const cents = (v: number | null) => (v === null ? 0 : toCents(v));
  return {
    actual: lines.reduce((s, l) => s + toCents(l.actual), 0),
    budget: lines.some((l) => l.budget !== null) ? lines.reduce((s, l) => s + cents(l.budget), 0) : null,
    projected: lines.reduce((s, l) => s + toCents(l.projected), 0),
    fyBudget: lines.some((l) => l.fyBudget !== null) ? lines.reduce((s, l) => s + cents(l.fyBudget), 0) : null,
    unallocated: lines.reduce((s, l) => s + toCents(l.unallocatedBudget), 0),
  };
}

function combine(x: Sums, y: Sums, op: 'plus' | 'minus'): Sums {
  const f = op === 'plus' ? plus : minus;
  return {
    actual: op === 'plus' ? x.actual + y.actual : x.actual - y.actual,
    budget: f(x.budget, y.budget),
    projected: op === 'plus' ? x.projected + y.projected : x.projected - y.projected,
    fyBudget: f(x.fyBudget, y.fyBudget),
    // Unallocated budget is budget nobody split: it is listed, not netted, so it always adds.
    unallocated: x.unallocated + y.unallocated,
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
    unallocatedBudget: fromCents(s.unallocated),
  };
}

/** The eight bands and totals, in statement order. */
export function buildBands(lines: readonly TrackingLine[]): TrackingBand[] {
  const sums = new Map(BANDS.map((b) => [b.key, sumLines(lines.filter((l) => l.band === b.key))]));
  const band = (key: TrackingBandKey) => {
    const def = BANDS.find((b) => b.key === key)!;
    return figures(key, def.label, 'band', def.polarity, sums.get(key)!);
  };
  const s = (key: TrackingBandKey) => sums.get(key)!;
  const gross = combine(s('turnover'), s('cost_of_sales'), 'minus');
  const operating = combine(combine(gross, s('other_income'), 'plus'), s('operating_expense'), 'minus');
  const net = combine(operating, s('other_expense'), 'minus');
  const total = (key: TrackingTotalKey, label: string, kind: 'total' | 'grand', x: Sums) => figures(key, label, kind, 'income', x);
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
