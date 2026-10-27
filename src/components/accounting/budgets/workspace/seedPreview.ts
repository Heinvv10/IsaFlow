/**
 * The create wizard's preview (spec 8): Turnover / Gross profit / Net profit for the prior year
 * and for the version about to be created, computed client-side from the same `uplift` and
 * `foldBands` the server uses. One series per account (per member at a dimension grain), each
 * through `uplift`, so the new figures are what the seed will insert, to the cent. Approximation:
 * the server also treats a member that is not an active cost centre of that type as unassigned;
 * the client does not know member types, so a preview at a dimension grain may differ for those.
 */
import { foldBands, type Band } from '@/modules/accounting/services/budgets/grid/subtotals';
import { uplift } from '@/modules/accounting/services/budgets/grid/spread';
import { toCents, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { GridAccount, GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';

export type PreviewAccount = Pick<GridAccount, 'id' | 'band' | 'isActive' | 'isHeader'>;
export type Unassigned = 'company' | 'drop';
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

function upliftAll(series: readonly Series[], pct: number, unit: RoundingUnit, n: number): PreviewResult {
  const out: Series[] = [];
  for (const s of series) {
    const r = uplift(s.cents, pct, unit);
    if (!r.ok) return r;
    out.push({ band: s.band, cents: r.months });
  }
  return { ok: true, figures: figuresOf(out, n) };
}

export interface PySeedOptions { grain: 'company' | 'cc1' | 'cc2' | 'bu'; unassigned: Unassigned; includeNoActivity: boolean; pct: number; unit: RoundingUnit }

/** What `POST budget-grid/seed` will insert for a PY-actuals source. */
export function pySeedFigures(accounts: readonly PreviewAccount[], prior: PriorActuals, o: PySeedOptions): PreviewResult {
  const n = prior.months.length;
  const byAccount = bandMap(accounts);
  const idx = new Map(prior.months.map((m, i) => [m, i]));
  const dims = new Map<string, Map<string | null, number[]>>();
  for (const c of prior.cells) {
    const i = idx.get(c.month);
    if (i === undefined) continue;
    const perDim = dims.get(c.glAccountId) ?? new Map<string | null, number[]>();
    const row = perDim.get(c.dimensionId) ?? Array<number>(n).fill(0);
    add(row, i, toCents(c.amount));
    perDim.set(c.dimensionId, row);
    dims.set(c.glAccountId, perDim);
  }
  const series: Series[] = [];
  for (const [id, perDim] of dims) {
    const a = byAccount.get(id);
    const live = [...perDim].filter(([, cents]) => cents.some((c) => c !== 0));
    if (!a || !a.isActive || a.isHeader || live.length === 0) continue;
    const unassigned = live.some(([d]) => d === null);
    if (o.grain === 'company' || (unassigned && o.unassigned === 'company')) {
      const total = Array<number>(n).fill(0);
      for (const [, cents] of perDim) cents.forEach((c, i) => add(total, i, c));
      series.push({ band: a.band, cents: total });
    } else {
      for (const [d, cents] of live) if (d !== null) series.push({ band: a.band, cents });
    }
  }
  if (o.includeNoActivity) {
    for (const a of accounts) {
      if (a.isActive && !a.isHeader && !dims.has(a.id)) series.push({ band: a.band, cents: Array<number>(n).fill(0) });
    }
  }
  return upliftAll(series, o.pct, o.unit, n);
}

/**
 * What the seed inserts for a version source: the source's own rows (headers and inactive accounts
 * included), months mapped by position onto the target's `n` months. A series keeps only the months the
 * source budgets, so the uplift's residue lands on its last budgeted month.
 */
export function versionSeedFigures(
  accounts: readonly PreviewAccount[], cells: readonly GridCell[], sourceMonths: readonly string[], n: number, pct: number, unit: RoundingUnit,
): PreviewResult {
  const byAccount = bandMap(accounts);
  const pos = new Map(sourceMonths.map((m, i) => [m, i]));
  const rows = new Map<string, { band: Band; at: Map<number, number> }>();
  for (const c of cells) {
    const p = pos.get(c.month);
    const a = byAccount.get(c.glAccountId);
    if (p === undefined || p >= n || !a) continue;
    const key = `${c.glAccountId}|${c.cc1Id ?? ''}|${c.cc2Id ?? ''}|${c.buId ?? ''}`;
    const row = rows.get(key) ?? { band: a.band, at: new Map<number, number>() };
    row.at.set(p, (row.at.get(p) ?? 0) + toCents(c.amount));
    rows.set(key, row);
  }
  const out: Series[] = [];
  for (const { band, at } of rows.values()) {
    const positions = [...at.keys()].sort((a, b) => a - b);
    const r = uplift(positions.map((p) => at.get(p) ?? 0), pct, unit);
    if (!r.ok) return r;
    const cents = Array<number>(n).fill(0);
    positions.forEach((p, i) => { cents[p] = r.months[i] ?? 0; });
    out.push({ band, cents });
  }
  return { ok: true, figures: figuresOf(out, n) };
}
