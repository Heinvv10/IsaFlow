/**
 * The grid store's engine (see gridStore.ts): the state, the per-row / per-metric listeners and
 * the recomputation. A write recomputes only the accounts it touched (their view row through PR-A
 * `resolveView`, their header roll-ups), moves the band sums by the difference, re-derives GP / OP /
 * NP (PR-A `deriveTotals`) and notifies only the rows and metrics whose snapshot changed.
 */
import type { GridAccount } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { type GridState, initialGridState } from '@/modules/accounting/services/budgets/grid/keyboard';
import { type View, resolveView, viewCellKey } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridShape } from '@/modules/accounting/services/budgets/grid/selection';
import { type BandSums, type Metric, bandSums, deriveTotals, foldBands } from '@/modules/accounting/services/budgets/grid/subtotals';
import { UndoStack } from '@/modules/accounting/services/budgets/grid/undo';
import { accountRowKey, rollupRowKey } from './gridLayout';
import {
  type Series, ancestorsOf, headersDeepestFirst, priorFor, rollupOf, sameSeries, selectionPart, sumOf,
} from './gridStoreParts';
import type { GridLayout, GridMeta, GridRowSnapshot, GridTotalSnapshot, LayoutRow } from './types';

export type LineRow = Extract<LayoutRow, { kind: 'line' }>;
interface OwnPart { values: Series; editable: boolean; readReason: string | null }
/** Per-view series that do not move with edits: PY per month, the compare version's FY (as a 1-item series). */
interface Extras { py: Map<string, number[]> | null; pyRollup: Map<string, Series>; compare: Map<string, Series> | null; compareRollup: Map<string, Series> }

export const ROLLUP_REASON = 'Sub-account roll-up';
const EMPTY_LAYOUT: GridLayout = { rows: [], months: [], rowKinds: [], cols: 1 };
const EMPTY_ROW: GridRowSnapshot = Object.freeze({
  values: [], fy: null, editable: false, readReason: null, dirty: [], conflict: [], py: null, pyFy: null,
  compareFy: null, focusCol: null, selected: null, editing: null,
});
const EMPTY_TOTAL: GridTotalSnapshot = Object.freeze({ months: [], fy: 0, pyFy: null, compareFy: null });
const METRICS: readonly Metric[] = ['turnover', 'costOfSales', 'grossProfit', 'otherIncome', 'operatingExpenses', 'operatingProfit', 'otherExpenses', 'netProfit'];

export class GridStoreCore {
  protected layout = EMPTY_LAYOUT;
  protected accounts = new Map<string, GridAccount>();
  protected view: View = { kind: 'company' };
  protected locked = false;
  protected canWrite = false;
  protected values = new Map<string, Map<CellKey, number | null>>();
  protected original = new Map<CellKey, number | null>();
  protected dirty = new Set<CellKey>();
  protected conflicts = new Set<CellKey>();
  protected readonly undoStack = new UndoStack();
  protected prior: PriorActuals | null = null;
  protected compare: Map<string, Map<CellKey, number | null>> | null = null;
  protected own = new Map<string, OwnPart>();
  protected rollups = new Map<string, Series>();
  protected ex: Extras = { py: null, pyRollup: new Map(), compare: null, compareRollup: new Map() };
  protected sums: BandSums = bandSums([], () => [], 0);
  protected rows = new Map<string, GridRowSnapshot>();
  protected totals = new Map<Metric, GridTotalSnapshot>();
  protected state: GridState = initialGridState({ rowKinds: [], cols: 1 });
  protected meta: GridMeta = { dirtyCount: 0, canUndo: false, canRedo: false, announcement: { seq: 0, text: '' }, notice: null, conflicts: [] };
  protected readonly rowListeners = new Map<string, Set<() => void>>();
  protected readonly totalListeners = new Map<Metric, Set<() => void>>();
  protected readonly metaListeners = new Set<() => void>();
  protected readonly layoutListeners = new Set<() => void>();

  // ── Read side (stable references for useSyncExternalStore) ────────────────
  getLayout = (): GridLayout => this.layout;
  getRow = (rowKey: string): GridRowSnapshot => this.rows.get(rowKey) ?? EMPTY_ROW;
  getTotal = (metric: Metric): GridTotalSnapshot => this.totals.get(metric) ?? EMPTY_TOTAL;
  getMeta = (): GridMeta => this.meta;
  getGridState = (): GridState => this.state;
  getView = (): View => this.view;
  getShape = (): GridShape => ({ rowKinds: this.layout.rowKinds, cols: this.layout.cols });

  subscribeLayout = (cb: () => void): (() => void) => { this.layoutListeners.add(cb); return () => { this.layoutListeners.delete(cb); }; };
  subscribeMeta = (cb: () => void): (() => void) => { this.metaListeners.add(cb); return () => { this.metaListeners.delete(cb); }; };
  subscribeRow(rowKey: string, cb: () => void): () => void { return listen(this.rowListeners, rowKey, cb); }
  subscribeTotal(metric: Metric, cb: () => void): () => void { return listen(this.totalListeners, metric, cb); }

  // ── Recomputation ─────────────────────────────────────────────────────────
  protected write(pairs: ReadonlyArray<readonly [CellKey, number | null]>): void {
    const touched = new Set<string>();
    for (const [k, v] of pairs) {
      const acct = k.slice(0, k.indexOf('|'));
      let m = this.values.get(acct);
      if (!m) { m = new Map(); this.values.set(acct, m); }
      m.set(k, v);
      if (v === (this.original.get(k) ?? null)) this.dirty.delete(k); else this.dirty.add(k);
      touched.add(acct);
    }
    this.refresh(touched);
  }

  protected computeOwn(id: string): OwnPart {
    const cells = this.values.get(id) ?? new Map<CellKey, number | null>();
    const row = resolveView({ accountIds: [id], months: this.layout.months, cells, locked: this.locked, canWrite: this.canWrite }, this.view).get(id);
    return { values: row?.values ?? [], editable: row?.editable ?? false, readReason: row?.readReason ?? null };
  }

  protected ownSeries = (id: string): Series => this.own.get(id)?.values ?? [];

  /** Recompute the touched accounts, their headers, the band sums by difference and the totals. */
  protected refresh(touched: ReadonlySet<string>): void {
    const n = this.layout.months.length;
    const changed = new Set<string>();
    const headers = new Set<string>();
    for (const id of touched) {
      const account = this.accounts.get(id);
      if (!account) continue;
      const before = this.ownSeries(id);
      const next = this.computeOwn(id);
      this.own.set(id, next);
      const band = this.sums[account.band];
      for (let m = 0; m < n; m++) band[m] = (band[m] ?? 0) + (next.values[m] ?? 0) - (before[m] ?? 0);
      changed.add(accountRowKey(id));
      for (const h of ancestorsOf(account, this.accounts)) headers.add(h);
    }
    for (const h of headersDeepestFirst([...headers].map(id => this.accounts.get(id)!))) {
      this.rollups.set(h.id, rollupOf(h, n, this.ownSeries, this.rollups));
      changed.add(rollupRowKey(h.id));
    }
    for (const row of this.layout.rows) if (row.kind === 'line' && changed.has(row.key)) this.setRow(row.key, this.buildRow(row));
    this.refreshTotals(false);
    this.refreshMeta();
  }

  protected rebuildAll(): void {
    const n = this.layout.months.length;
    this.own = new Map([...this.accounts.keys()].map(id => [id, this.computeOwn(id)]));
    this.rollups = new Map();
    for (const h of headersDeepestFirst(this.accounts.values())) this.rollups.set(h.id, rollupOf(h, n, this.ownSeries, this.rollups));
    this.sums = bandSums([...this.accounts.values()], a => this.ownSeries(a.id), n);
    this.ex = this.computeExtras();
    for (const row of this.layout.rows) if (row.kind === 'line') this.setRow(row.key, this.buildRow(row));
    this.refreshTotals(true);
    this.refreshMeta();
  }

  /** Static per-row extras (PY, compare) for the current view, header roll-ups included. */
  protected computeExtras(): Extras {
    const n = this.layout.months.length;
    const headers = headersDeepestFirst(this.accounts.values());
    const py = priorFor(this.prior, this.view, this.layout.months);
    const pyRollup = new Map<string, Series>();
    if (py) for (const h of headers) pyRollup.set(h.id, rollupOf(h, n, id => py.get(id) ?? [], pyRollup));
    if (!this.compare) return { py, pyRollup, compare: null, compareRollup: new Map() };
    const compare = new Map<string, Series>();
    for (const id of this.accounts.keys()) {
      const row = resolveView({ accountIds: [id], months: this.layout.months, cells: this.compare.get(id) ?? new Map() }, this.view).get(id);
      compare.set(id, [sumOf(row?.values ?? [])]);
    }
    const compareRollup = new Map<string, Series>();
    for (const h of headers) compareRollup.set(h.id, rollupOf(h, 1, id => compare.get(id) ?? [], compareRollup));
    return { py, pyRollup, compare, compareRollup };
  }

  protected buildRow(row: LineRow): GridRowSnapshot {
    const id = row.account.id;
    const ex = this.ex;
    const sel = selectionPart(this.state, row.index);
    const rollup = row.role === 'rollup';
    const values = rollup ? this.rollups.get(id) ?? [] : this.own.get(id)?.values ?? [];
    const pySeries = ex.py ? (rollup ? ex.pyRollup.get(id) : ex.py.get(id)) ?? [] : null;
    const py = pySeries ? this.layout.months.map((_, m) => pySeries[m] ?? 0) : null;
    const cmp = ex.compare ? (rollup ? ex.compareRollup.get(id) : ex.compare.get(id))?.[0] ?? null : null;
    const common = { values, fy: sumOf(values), py, pyFy: py ? sumOf(py) : null, compareFy: cmp, ...sel };
    if (rollup) {
      const none = values.map(() => false);
      return { ...common, editable: false, readReason: ROLLUP_REASON, dirty: none, conflict: none };
    }
    const own = this.own.get(id);
    const keys = this.layout.months.map(m => viewCellKey(id, this.view, m));
    return {
      ...common, editable: own?.editable ?? false, readReason: own?.readReason ?? null,
      dirty: keys.map(k => this.dirty.has(k)), conflict: keys.map(k => this.conflicts.has(k)),
    };
  }

  protected refreshTotals(all: boolean): void {
    const n = this.layout.months.length;
    const t = deriveTotals(this.sums, n);
    let pyFy: Record<Metric, number> | null = null;
    let cmpFy: Record<Metric, number> | null = null;
    const { py, compare } = this.ex;
    if (all) {
      const list = [...this.accounts.values()];
      if (py) pyFy = foldBands(list, a => py.get(a.id) ?? [], n).fy;
      if (compare) cmpFy = foldBands(list, a => compare.get(a.id) ?? [], 1).fy;
    }
    for (const m of METRICS) {
      const prev = this.totals.get(m);
      const next = { months: t.months[m], fy: t.fy[m], pyFy: all ? pyFy?.[m] ?? null : prev?.pyFy ?? null, compareFy: all ? cmpFy?.[m] ?? null : prev?.compareFy ?? null };
      if (!all && prev && prev.fy === next.fy && sameSeries(prev.months, next.months)) continue;
      this.totals.set(m, next);
      for (const cb of [...(this.totalListeners.get(m) ?? [])]) cb();
    }
  }

  protected setRow(key: string, snap: GridRowSnapshot): void {
    this.rows.set(key, snap);
    for (const cb of [...(this.rowListeners.get(key) ?? [])]) cb();
  }

  protected refreshMeta(): void {
    const conflicts = this.conflicts.size === this.meta.conflicts.length && this.meta.conflicts.every(k => this.conflicts.has(k)) ? this.meta.conflicts : [...this.conflicts];
    this.setMeta({ dirtyCount: this.dirty.size, canUndo: this.undoStack.canUndo, canRedo: this.undoStack.canRedo, conflicts });
  }

  protected setMeta(patch: Partial<GridMeta>): void {
    const next = { ...this.meta, ...patch };
    if ((Object.keys(patch) as (keyof GridMeta)[]).every(k => next[k] === this.meta[k])) return;
    this.meta = next;
    for (const cb of [...this.metaListeners]) cb();
  }
}

function listen<K>(map: Map<K, Set<() => void>>, key: K, cb: () => void): () => void {
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(cb);
  return () => { set.delete(cb); };
}
