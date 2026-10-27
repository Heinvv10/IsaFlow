/**
 * The create wizard's preview (spec 8): Turnover / Gross profit / Net profit for the prior year
 * and for the version about to be created, computed client-side from the same `uplift` and
 * `foldBands` the server uses. One series per account (per member at a dimension grain), each
 * through `uplift`, so the new figures are what the seed will insert, to the cent. The series come
 * from the server's own pure rules (`seedSeriesCore`). One difference: the server treats a member
 * that is not an active cost centre of that type as unassigned; the client cannot tell member
 * types, so it accepts every member.
 */
import { foldBands, type Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { uplift } from '@/modules/accounting/services/budgets/grid/spread';
import { toCents, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { GridAccount, GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals, PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';
import { pySeriesFrom, versionSeriesFrom, type SeedSeries } from '@/modules/accounting/services/budgets/seedSeriesCore';

export type PreviewAccount = Pick<GridAccount, 'id' | 'band' | 'isActive' | 'isHeader'>;
export type { UnassignedRule as Unassigned } from '@/modules/accounting/services/budgets/seedSeriesCore';
import type { UnassignedRule as Unassigned } from '@/modules/accounting/services/budgets/seedSeriesCore';
export type PreviewMetric = 'turnover' | 'grossProfit' | 'netProfit';
export const PREVIEW_METRICS: readonly { metric: PreviewMetric; label: string }[] = [
  { metric: 'turnover', label: 'Turnover' }, { metric: 'grossProfit', label: 'Gross profit' }, { metric: 'netProfit', label: 'Net profit' },
];
/** Cents per metric, FY. */
export type PreviewFigures = Record<PreviewMetric, number>;
export type PreviewResult = { ok: true; figures: PreviewFigures } | { ok: false; reason: string };

interface Series { band: Band; cents: number[] }

const figuresOf = (series: readonly Series[], n: number): PreviewFigures => {
  const fy = foldBands(series, (s) => s.cents, n).fy;
  return { turnover: fy.turnover, grossProfit: fy.grossProfit, netProfit: fy.netProfit };
};

const bandMap = (accounts: readonly PreviewAccount[]) => new Map(accounts.map((a) => [a.id, a]));
const add = (into: number[], i: number, c: number) => { into[i] = (into[i] ?? 0) + c; };

/** The prior year's actual figures, every account as posted (headers and inactive accounts included). */
export function priorFigures(accounts: readonly PreviewAccount[], prior: PriorActuals): PreviewFigures {
  const n = prior.months.length;
  const byAccount = bandMap(accounts);
  const idx = new Map(prior.months.map((m, i) => [m, i]));
  const sums = new Map<string, number[]>();
  for (const c of prior.cells) {
    const i = idx.get(c.month);
    if (i === undefined || !byAccount.has(c.glAccountId)) continue;
    const row = sums.get(c.glAccountId) ?? Array<number>(n).fill(0);
    add(row, i, toCents(c.amount));
    sums.set(c.glAccountId, row);
  }
  return figuresOf([...sums].map(([id, cents]) => ({ band: byAccount.get(id)!.band, cents })), n);
}

/** Each series through `uplift` (what the seed inserts), folded into figures by its account's band. */
function upliftSeries(series: readonly SeedSeries[], byAccount: ReadonlyMap<string, PreviewAccount>, pct: number, unit: RoundingUnit, n: number): PreviewResult {
  const out: Series[] = [];
  for (const s of series) {
    const a = byAccount.get(s.glAccountId);
    if (!a) continue;
    const r = uplift(s.cents, pct, unit);
    if (!r.ok) return r;
    const cents = Array<number>(n).fill(0);
    s.positions.forEach((p, i) => { cents[p] = r.months[i] ?? 0; });
    out.push({ band: a.band, cents });
  }
  return { ok: true, figures: figuresOf(out, n) };
}

export interface PySeedOptions { grain: PriorGrain; unassigned: Unassigned; includeNoActivity: boolean; pct: number; unit: RoundingUnit }

/** What `POST budget-grid/seed` will insert for a PY-actuals source: the server's own series rules (`seedSeriesCore`). */
export function pySeedFigures(accounts: readonly PreviewAccount[], prior: PriorActuals, o: PySeedOptions): PreviewResult {
  const byAccount = bandMap(accounts);
  const { series } = pySeriesFrom(prior, byAccount, null, o);
  return upliftSeries(series, byAccount, o.pct, o.unit, prior.months.length);
}

/** What the seed inserts for a version source: months mapped by position onto the target's `n` months. */
export function versionSeedFigures(
  accounts: readonly PreviewAccount[], cells: readonly GridCell[], sourceMonths: readonly string[], n: number, pct: number, unit: RoundingUnit,
): PreviewResult {
  const byAccount = bandMap(accounts);
  return upliftSeries(versionSeriesFrom(cells, sourceMonths, n), byAccount, pct, unit, n);
}
