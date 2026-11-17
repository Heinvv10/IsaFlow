/**
 * The diff a budget amount write answers (dry run and live), from what the grid save ACTUALLY leaves: the
 * version's cells read before and after the save (in a dry run, after it inside the rolled-back savepoint).
 * So a cleared override shows the driver value it reset to, and a driver's dependents the save recomputed
 * (other accounts included) are listed as `recomputed`. Counts per status, the changed / added / removed /
 * recomputed / refused cells paged so the reply stays well under the client limit (MAX_READ_RESULT_BYTES),
 * and the version's section totals per month before and after.
 */
import { cellKey, parseKey, type CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { bandTotals, ownMonths } from '@/modules/accounting/services/budgets/gridTotals';
import type { GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { CurrentCell, PlanEntry } from '@/modules/accounting/services/budgets/cellWritePlan';
import type { SnapshotCell } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { centsText, randText } from './budgetToolArgs';

/** Default and largest page of listed cells: ~150 bytes each, so 400 stay near 60 KB with the totals. */
export const DIFF_LIST_DEFAULT = 200;
export const DIFF_LIST_MAX = 400;

export type CellMap = Map<CellKey, CurrentCell>;

/** A requested cell refused before it had a cell key (unresolved account or member, bad month or amount). */
export interface RowRefusal { index: number; account: string; month: string; dimension: string | null; reason: string }

export function cellMap(cells: readonly GridCell[]): CellMap {
  return new Map(cells.map((c) => [cellKey(c), { cents: toCents(c.amount), source: c.source }]));
}

export type ActualStatus = 'added' | 'changed' | 'removed' | 'unchanged' | 'recomputed' | 'refused';

const same = (a: CurrentCell | undefined, b: CurrentCell | undefined) => (a === undefined ? b === undefined : b !== undefined && a.cents === b.cents && a.source === b.source);

function statusOf(before: CurrentCell | undefined, after: CurrentCell | undefined): ActualStatus {
  if (same(before, after)) return 'unchanged';
  if (before === undefined) return 'added';
  return after === undefined ? 'removed' : 'changed';
}

export interface ActualDiff { index: number | null; key: CellKey; status: ActualStatus; before?: CurrentCell; after?: CurrentCell; reason?: string }

/** Every planned cell (requested, or cleared by replace) with its ACTUAL outcome, then every other cell the save changed. */
export function actualDiff(entries: readonly PlanEntry[], before: CellMap, after: CellMap): ActualDiff[] {
  const out: ActualDiff[] = [];
  const planned = new Set<CellKey>();
  for (const e of entries) {
    planned.add(e.key);
    if (e.status === 'refused') { out.push({ index: e.index, key: e.key, status: 'refused', reason: e.reason }); continue; }
    out.push({ index: e.index, key: e.key, status: statusOf(before.get(e.key), after.get(e.key)), before: before.get(e.key), after: after.get(e.key) });
  }
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (planned.has(key) || same(before.get(key), after.get(key))) continue;
    out.push({ index: null, key, status: 'recomputed', before: before.get(key), after: after.get(key) });
  }
  return out;
}

/**
 * The cells the PLAN would leave, for a dry run whose refused rows stop the save from running: so the other
 * cells are counted and listed, and the totals shown, by what they would do (a driver's recomputes are
 * unknown until the save runs).
 */
export function plannedAfter(entries: readonly PlanEntry[], before: CellMap): CellMap {
  const after = new Map(before);
  for (const e of entries) {
    if (e.status === 'refused' || e.status === 'unchanged') continue;
    if (e.after === null) after.delete(e.key);
    else after.set(e.key, { cents: e.after, source: 'manual' });
  }
  return after;
}

/** The snapshot of a write: the PLANNED cells the save changed, before and after with their sources. */
export function snapshotCells(diff: readonly ActualDiff[]): SnapshotCell[] {
  const money = (c: CurrentCell | undefined) => (c === undefined ? null : centsText(c.cents));
  return diff.filter((d) => d.status === 'added' || d.status === 'changed' || d.status === 'removed').map((d) => {
    const r = parseKey(d.key);
    return { a: r.glAccountId, c1: r.cc1Id, c2: r.cc2Id, b: r.buId, m: r.month, before: money(d.before), after: money(d.after), bs: d.before?.source ?? null, as: d.after?.source ?? null };
  });
}

/** Account codes and `{ kind, code }` of a cell's member, as the replies name them. */
export function cellLabels(model: GridReadModel) {
  const accounts = new Map(model.accounts.map((a) => [a.id, a.code]));
  const members = new Map<string, string>();
  for (const kind of ['cc1', 'cc2', 'bu'] as const) for (const m of model.dimensions[kind]) members.set(`${kind}:${m.id}`, m.code);
  return {
    account: (id: string) => accounts.get(id) ?? id,
    dimension: (ref: { cc1Id: string | null; cc2Id: string | null; buId: string | null }) => {
      const [kind, id] = ref.cc1Id ? ['cc1', ref.cc1Id] : ref.cc2Id ? ['cc2', ref.cc2Id] : ref.buId ? ['bu', ref.buId] : [null, null];
      return kind === null ? null : { kind, code: members.get(`${kind}:${id}`) ?? id };
    },
  };
}

export interface DiffPage { offset: number; limit: number }

/** Counts, the listed page and the paging fields. */
export function diffListing(model: GridReadModel, diff: readonly ActualDiff[], rowRefusals: readonly RowRefusal[], page: DiffPage) {
  const name = cellLabels(model);
  const money = (c: CurrentCell | undefined) => (c === undefined ? null : centsText(c.cents));
  const listed: Array<Record<string, unknown> & { i: number | null }> = [
    ...rowRefusals.map((r) => ({ i: r.index, account: r.account, dimension: r.dimension, month: r.month, status: 'refused', reason: r.reason })),
    ...diff.filter((d) => d.status !== 'unchanged').map((d) => {
      const ref = parseKey(d.key);
      return {
        i: d.index, account: name.account(ref.glAccountId), dimension: name.dimension(ref), month: ref.month, status: d.status,
        ...(d.status === 'refused' ? { reason: d.reason } : { before: money(d.before), after: money(d.after) }),
        ...(d.after && d.after.source !== 'manual' ? { source: d.after.source } : {}),
      };
    }),
  ].sort((a, b) => (a.i ?? Infinity) - (b.i ?? Infinity));
  const counts: Record<ActualStatus, number> = { added: 0, changed: 0, removed: 0, unchanged: 0, recomputed: 0, refused: rowRefusals.length };
  for (const d of diff) counts[d.status] += 1;
  const cells = listed.slice(page.offset, page.offset + page.limit);
  const next = page.offset + cells.length;
  return { counts, cells, listed_total: listed.length, truncated: next < listed.length, next_offset: next < listed.length ? next : null };
}

/** The version's band totals and GP / OP / NP per month and for the year, before and after (decimal text). */
export function sectionTotals(model: GridReadModel, before: CellMap, after: CellMap) {
  const months = model.year.monthKeys;
  const view = (cells: CellMap) => {
    const t = bandTotals(model.accounts, ownMonths([...cells].map(([k, v]) => [k, v.cents] as const), months), months.length);
    return Object.fromEntries(Object.entries(t.months).map(([metric, values]) => [metric, {
      year: randText(t.fy[metric as keyof typeof t.fy]), months: values.map(randText),
    }]));
  };
  return { months, before: view(before), after: view(after) };
}
