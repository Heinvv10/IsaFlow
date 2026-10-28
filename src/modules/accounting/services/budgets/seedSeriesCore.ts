/**
 * The pure rules of the wizard's seed series (Budgets P2 spec 8), shared by the server
 * (`seedSeries.ts`, which adds the reads) and the wizard's client preview, so the preview shows
 * what the seed inserts. No I/O and no server imports: this file is in the client bundle.
 *
 * PY actuals (leaf accounts only, decision 18): dense series, every month of the year, so a month
 * with no activity is an explicit 0. At a dimension grain a PY row with NO member ("unassigned")
 * would mix grains for its account (decision 4); a row on a member the budget cannot take counts
 * as unassigned too, never written to that member. Per account: `unassigned: 'company'` (default)
 * makes an account that has any unassigned activity company grain ENTIRELY (all its rows summed);
 * `'drop'` keeps only its tagged series. Accounts with no activity at all (`includeNoActivity`)
 * become zero company rows.
 *
 * Version source: the source's own rows, months mapped by position (months past the target's
 * length dropped). A series keeps only the months the source budgets, so the uplift's residue
 * lands on its last budgeted month.
 */
import { toCents } from './grid/cents';
import type { PriorGrain } from './priorActuals';

export type UnassignedRule = 'company' | 'drop';

export interface SeedSeries {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** Indexes into the target year's months, ascending. */
  positions: number[];
  /** Integer cents, one per position. */
  cents: number[];
}

/** What the leaf rule needs to know of an account. */
export interface SeedAccountFacts { id: string; isActive: boolean; isHeader: boolean }

export interface PySeriesOptions { grain: PriorGrain; unassigned: UnassignedRule; includeNoActivity: boolean }

/** A prior-year actual (rand) on a budget-year month; `dimensionId` is the CC1 / CC2 / BU member at a dimension grain. */
export interface PriorCellInput { glAccountId: string; dimensionId: string | null; month: string; amount: number }

const sumArrays = (arrays: Iterable<number[]>, n: number): number[] => {
  const total = Array<number>(n).fill(0);
  for (const a of arrays) for (let i = 0; i < n; i++) total[i] = (total[i] ?? 0) + (a[i] ?? 0);
  return total;
};
const seriesKey = (s: Pick<SeedSeries, 'glAccountId' | 'cc1Id' | 'cc2Id' | 'buId'>): string =>
  `${s.glAccountId}|${s.cc1Id ?? ''}|${s.cc2Id ?? ''}|${s.buId ?? ''}`;
const active = (cents: readonly number[]): boolean => cents.some((c) => c !== 0);
const dense = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function dimColumns(grain: PriorGrain, dimensionId: string | null): Pick<SeedSeries, 'cc1Id' | 'cc2Id' | 'buId'> {
  return { cc1Id: grain === 'cc1' ? dimensionId : null, cc2Id: grain === 'cc2' ? dimensionId : null, buId: grain === 'bu' ? dimensionId : null };
}

/**
 * PY-actuals series for the budget year's `prior.months`, and how many accounts with activity were
 * left out (headers, inactive). `members`: the members a dimension grain may budget (an empty set
 * at company grain); null accepts every member id (the client, which cannot tell member types).
 */
export function pySeriesFrom(
  prior: { months: readonly string[]; cells: readonly PriorCellInput[] },
  accounts: ReadonlyMap<string, SeedAccountFacts>,
  members: ReadonlySet<string> | null,
  opts: PySeriesOptions,
): { series: SeedSeries[]; skipped: number } {
  const n = prior.months.length;
  const monthIndex = new Map(prior.months.map((m, i) => [m, i]));
  const byAccount = new Map<string, Map<string | null, number[]>>();
  for (const c of prior.cells) {
    const i = monthIndex.get(c.month);
    if (i === undefined) continue;
    const dim = c.dimensionId !== null && (members === null || members.has(c.dimensionId)) ? c.dimensionId : null;
    const dims = byAccount.get(c.glAccountId) ?? new Map<string | null, number[]>();
    const cents = dims.get(dim) ?? Array<number>(n).fill(0);
    cents[i] = (cents[i] ?? 0) + toCents(c.amount);
    dims.set(dim, cents);
    byAccount.set(c.glAccountId, dims);
  }

  const series: SeedSeries[] = [];
  const touched = new Set<string>();
  let skipped = 0;
  for (const [glAccountId, dims] of byAccount) {
    const live = [...dims].filter(([, cents]) => active(cents));
    if (live.length === 0) continue;
    touched.add(glAccountId);
    const account = accounts.get(glAccountId);
    if (!account || !account.isActive || account.isHeader) {
      skipped += 1;
      continue;
    }
    const unassigned = live.some(([dim]) => dim === null);
    if (opts.grain === 'company' || (unassigned && opts.unassigned === 'company')) {
      series.push({ glAccountId, ...dimColumns('company', null), positions: dense(n), cents: sumArrays(dims.values(), n) });
    } else {
      for (const [dim, cents] of live) if (dim !== null) series.push({ glAccountId, ...dimColumns(opts.grain, dim), positions: dense(n), cents });
    }
  }
  if (opts.includeNoActivity) {
    for (const a of accounts.values()) {
      if (a.isActive && !a.isHeader && !touched.has(a.id)) {
        series.push({ glAccountId: a.id, ...dimColumns('company', null), positions: dense(n), cents: Array<number>(n).fill(0) });
      }
    }
  }
  series.sort((a, b) => (seriesKey(a) < seriesKey(b) ? -1 : 1));
  return { series, skipped };
}

export interface VersionCellInput { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; month: string; amount: number }

/** The source version's series, its months (`sourceMonths`) mapped by position onto a target year of `targetMonths` months. */
export function versionSeriesFrom(rows: readonly VersionCellInput[], sourceMonths: readonly string[], targetMonths: number): SeedSeries[] {
  const positionOf = new Map(sourceMonths.map((m, i) => [m, i]));
  const grouped = new Map<string, { head: Omit<SeedSeries, 'positions' | 'cents'>; byPosition: Map<number, number> }>();
  for (const r of rows) {
    const position = positionOf.get(r.month);
    if (position === undefined || position >= targetMonths) continue;
    const head = { glAccountId: r.glAccountId, cc1Id: r.cc1Id, cc2Id: r.cc2Id, buId: r.buId };
    const key = seriesKey(head);
    const entry = grouped.get(key) ?? { head, byPosition: new Map<number, number>() };
    entry.byPosition.set(position, (entry.byPosition.get(position) ?? 0) + toCents(r.amount));
    grouped.set(key, entry);
  }
  return [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, { head, byPosition }]) => {
    const positions = [...byPosition.keys()].sort((a, b) => a - b);
    return { ...head, positions, cents: positions.map((p) => byPosition.get(p) ?? 0) };
  });
}
