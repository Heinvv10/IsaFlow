/**
 * The diff a budget amount write answers (dry run and live): counts per status, the changed / added /
 * removed / refused cells paged so the reply stays well under the client limit (MAX_READ_RESULT_BYTES),
 * and the version's section totals per month before and after. Amounts only for a token with read:reports.
 */
import { cellKey, parseKey, type CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { bandTotals, ownMonths } from '@/modules/accounting/services/budgets/gridTotals';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { countPlan, type CurrentCell, type PlanEntry } from '@/modules/accounting/services/budgets/cellWritePlan';
import { centsText, randText } from './budgetToolArgs';

/** Default and largest page of listed cells: ~150 bytes each with amounts, so 400 stay near 60 KB with the totals. */
export const DIFF_LIST_DEFAULT = 200;
export const DIFF_LIST_MAX = 400;

/** A requested cell refused before it had a cell key (unresolved account or member, bad month or amount). */
export interface RowRefusal { index: number; account: string; month: string; dimension: string | null; reason: string }

export function currentCells(model: GridReadModel): Map<CellKey, CurrentCell> {
  const out = new Map<CellKey, CurrentCell>();
  for (const c of model.cells) {
    out.set(cellKey(c), { cents: toCents(c.amount), source: c.source });
  }
  return out;
}

function labels(model: GridReadModel) {
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
export function diffListing(model: GridReadModel, entries: readonly PlanEntry[], rowRefusals: readonly RowRefusal[], page: DiffPage, figures: boolean) {
  const name = labels(model);
  const money = (c: number | null) => (c === null ? null : centsText(c));
  const listed: Array<Record<string, unknown>> = [
    ...rowRefusals.map((r) => ({ i: r.index, account: r.account, dimension: r.dimension, month: r.month, status: 'refused', reason: r.reason })),
    ...entries.filter((e) => e.status !== 'unchanged').map((e) => {
      const ref = parseKey(e.key);
      return {
        i: e.index, account: name.account(ref.glAccountId), dimension: name.dimension(ref), month: ref.month, status: e.status,
        ...(figures && e.status !== 'refused' ? { before: money(e.before), after: money(e.after) } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
      };
    }),
  ].sort((a, b) => (a.i === null ? Infinity : Number(a.i)) - (b.i === null ? Infinity : Number(b.i)));
  const counts = countPlan(entries);
  counts.refused += rowRefusals.length;
  const cells = listed.slice(page.offset, page.offset + page.limit);
  const next = page.offset + cells.length;
  return { counts, cells, listed_total: listed.length, truncated: next < listed.length, next_offset: next < listed.length ? next : null };
}

/** The version's band totals and GP / OP / NP per month and for the year, before and after the write (decimal text). */
export function sectionTotals(model: GridReadModel, current: ReadonlyMap<CellKey, CurrentCell>, entries: readonly PlanEntry[]) {
  const before = new Map<CellKey, number>([...current].map(([k, v]) => [k, v.cents]));
  const after = new Map(before);
  for (const e of entries) {
    if (e.status === 'refused' || e.status === 'unchanged') continue;
    if (e.after === null) after.delete(e.key); else after.set(e.key, e.after);
  }
  const months = model.year.monthKeys;
  const view = (cells: Map<CellKey, number>) => {
    const t = bandTotals(model.accounts, ownMonths(cells, months), months.length);
    return Object.fromEntries(Object.entries(t.months).map(([metric, values]) => [metric, {
      year: randText(t.fy[metric as keyof typeof t.fy]), months: values.map(randText),
    }]));
  };
  return { months, before: view(before), after: view(after) };
}
