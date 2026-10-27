/**
 * The workspace grid's external store (spec §4.4, §5.5, §5.6, §13), read through
 * `useSyncExternalStore` (gridStoreHooks.ts). Values are integer cents by cell key; `original` is
 * what was loaded or last saved; a cell is dirty while it differs from it. One `apply` is one
 * undo entry (PR-A `UndoStack`). Subscriptions are per ROW and per METRIC (gridStoreCore.ts), so
 * one edit re-renders its row, its header roll-ups and the subtotals it moved. Snapshots are
 * immutable and replaced on change.
 */
import type { GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { type CellKey, type Dimension, parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { type GridContext, type GridState, initialGridState } from '@/modules/accounting/services/budgets/grid/keyboard';
import { type View, memberTotals, viewCellKey } from '@/modules/accounting/services/budgets/grid/pivot';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';
import type { FillGrid } from '@/modules/accounting/services/budgets/grid/fill';
import { BAND_SIGN, type Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import { fromCents } from '@/modules/accounting/services/budgets/grid/cents';
import { centsToPlain } from '@/modules/accounting/services/budgets/grid/tsv';
import { accountRowKey, buildLayout, rollupRowKey } from './gridLayout';
import { GridStoreCore, type LineRow, METRICS, ROLLUP_REASON } from './gridStoreCore';
import { byAccount, cellsInCents, sameSelection, selectionPart, touchedRows } from './gridStoreParts';
import type { InvalidCellNotice } from './types';

export { accountRowKey, rollupRowKey, ROLLUP_REASON };

export interface CellWriteByKey { key: CellKey; cents: number | null }
export interface ResetOptions {
  view: View;
  canWrite: boolean;
  /** Defaults to the version's status. */
  locked?: boolean;
  /** Values laid over the loaded cells (a 409 re-apply: `rebaseDirty().values`). */
  values?: ReadonlyMap<CellKey, number | null>;
  conflicts?: readonly CellKey[];
}

export class GridStore extends GridStoreCore {
  // ── Loading ───────────────────────────────────────────────────────────────
  reset(model: GridReadModel, opts: ResetOptions): void {
    this.accounts = new Map(model.accounts.map(a => [a.id, a]));
    this.layout = buildLayout(model.accounts, model.year.monthKeys);
    this.original = cellsInCents(model.cells);
    const current = new Map(this.original);
    for (const [k, v] of opts.values ?? []) current.set(k, v);
    this.values = byAccount(current);
    this.dirty = new Set([...current].filter(([k, v]) => v !== (this.original.get(k) ?? null)).map(([k]) => k));
    this.conflicts = new Set(opts.conflicts ?? []);
    this.locked = opts.locked ?? model.version?.status === 'locked';
    this.canWrite = opts.canWrite;
    this.view = opts.view;
    this.prior = null;
    this.compare = null;
    this.undoStack.clear();
    const keep = this.layout.rows[this.state.focus.r]?.kind === 'line' && this.state.focus.c < this.layout.cols;
    this.state = keep ? { ...this.state, anchor: this.state.focus, mode: 'nav', draft: '', editOrigin: null } : initialGridState(this.getShape());
    this.rebuildAll();
    this.bumpRevision();
    for (const cb of [...this.layoutListeners]) cb();
  }

  /** Dirty values survive a view switch; the undo stack does not (spec §5.5). */
  /**
   * Dirty values AND the undo stack survive a view switch: a cell key does not depend on the view,
   * so undo restores the right cells from any view (deliberate deviation from spec §5.5, which
   * cleared the stack behind a confirm).
   */
  setView(view: View): void { this.view = view; this.rebuildAll(); }
  /** The role arrived or changed after the load: editability follows, values and undo stay. */
  setAccess(canWrite: boolean): void { if (canWrite !== this.canWrite) { this.canWrite = canWrite; this.rebuildAll(); } }
  setPrior(prior: PriorActuals | null): void { this.prior = prior; this.rebuildAll(); }
  setCompare(cells: readonly GridCell[] | null): void { this.compare = cells ? byAccount(cellsInCents(cells)) : null; this.rebuildAll(); }

  // ── Writes ────────────────────────────────────────────────────────────────
  valueAt(key: CellKey): number | null { return this.values.get(key.slice(0, key.indexOf('|')))?.get(key) ?? null; }

  /** One undo entry for the whole batch; returns the number of cells that changed. */
  apply(writes: readonly CellWriteByKey[]): number {
    const changes = new Map<CellKey, { key: CellKey; before: number | null; after: number | null }>();
    for (const w of writes) {
      parseKey(w.key);
      const seen = changes.get(w.key);
      changes.set(w.key, { key: w.key, before: seen ? seen.before : this.valueAt(w.key), after: w.cents });
    }
    const real = [...changes.values()].filter(c => c.before !== c.after);
    if (real.length === 0) return 0;
    this.undoStack.push(real);
    this.write(real.map(c => [c.key, c.after]));
    return real.length;
  }

  undo(): number { const e = this.undoStack.undo(); if (e) this.write(e.map(c => [c.key, c.before])); else this.refreshMeta(); return e?.length ?? 0; }
  redo(): number { const e = this.undoStack.redo(); if (e) this.write(e.map(c => [c.key, c.after])); else this.refreshMeta(); return e?.length ?? 0; }

  /** The unsaved cells (null = clear), in the order they were first edited: what a save sends. */
  dirtyMap(): Map<CellKey, number | null> { return new Map([...this.dirty].map(k => [k, this.valueAt(k)])); }
  originalMap(): Map<CellKey, number | null> { return new Map(this.original); }

  /** `saved` reached the server: it becomes the original; a cell edited since stays dirty. */
  markSaved(saved: ReadonlyMap<CellKey, number | null>): void {
    for (const [k, v] of saved) {
      this.original.set(k, v);
      this.conflicts.delete(k);
      if (this.valueAt(k) === v) this.dirty.delete(k); else this.dirty.add(k);
    }
    this.refresh(new Set([...saved.keys()].map(k => k.slice(0, k.indexOf('|')))));
  }

  discard(): void {
    this.values = byAccount(this.original);
    this.dirty.clear();
    this.conflicts.clear();
    this.undoStack.clear();
    this.rebuildAll();
    this.bumpRevision();
  }

  /** Any budgeted (non-null) cell at all, at any grain: the "no amounts yet" hint's test. */
  hasAmounts(): boolean {
    for (const m of this.values.values()) for (const v of m.values()) if (v !== null) return true;
    return false;
  }

  /** The live FY totals per metric, in RAND (what the wizard's "Current" column shows). */
  fyTotals(): Record<Metric, number> {
    return Object.fromEntries(METRICS.map(m => [m, fromCents(this.getTotal(m).fy)])) as Record<Metric, number>;
  }

  /** The account's budgeted (non-null) cells now, at every grain: what a grain change clears. */
  heldCells(accountId: string): Array<[CellKey, number]> {
    const out: Array<[CellKey, number]> = [];
    for (const [k, v] of this.values.get(accountId) ?? []) if (v !== null) out.push([k, v]);
    return out;
  }

  memberTotals(dim: Dimension): Map<string, number> {
    const all = new Map<CellKey, number | null>();
    for (const m of this.values.values()) for (const [k, v] of m) all.set(k, v);
    const sign = (id: string) => { const a = this.accounts.get(id); return a ? BAND_SIGN[a.band] : 0; };
    return memberTotals(all, this.layout.months, dim, sign);
  }

  // ── Grid positions (the reducer's world) ──────────────────────────────────
  lineAt(r: number): LineRow | null { const row = this.layout.rows[r]; return row?.kind === 'line' ? row : null; }

  cellKeyAt(p: Pos): CellKey | null {
    const line = this.lineAt(p.r);
    const month = this.layout.months[p.c];
    return line && line.role !== 'rollup' && month ? viewCellKey(line.account.id, this.view, month) : null;
  }

  isEditable = (p: Pos): boolean => {
    const line = this.lineAt(p.r);
    return line !== null && line.role !== 'rollup' && p.c >= 0 && p.c < this.layout.cols && (this.own.get(line.account.id)?.editable ?? false);
  };

  readReason = (p: Pos): string | null => {
    const line = this.lineAt(p.r);
    if (!line) return null;
    return line.role === 'rollup' ? ROLLUP_REASON : this.own.get(line.account.id)?.readReason ?? null;
  };

  /** The displayed cents at a month column, or the FY at the total column. */
  displayValue = (p: Pos): number | null => {
    const line = this.lineAt(p.r);
    if (!line) return null;
    const row = this.getRow(line.key);
    return p.c === this.layout.months.length ? row.fy : row.values[p.c] ?? null;
  };

  rowLabel(r: number): string { const a = this.lineAt(r)?.account; return a ? `${a.code} ${a.name}` : ''; }
  fillGrid(): FillGrid { return { shape: this.getShape(), isEditable: this.isEditable, valueAt: this.displayValue }; }
  gridContext(): GridContext {
    return { ...this.fillGrid(), readReason: this.readReason, rawValue: (p: Pos) => { const v = this.displayValue(p); return v === null ? '' : centsToPlain(v); } };
  }

  setGridState(next: GridState): void {
    const prev = this.state;
    this.state = next;
    for (const r of touchedRows(prev, next)) {
      const line = this.lineAt(r);
      const old = line ? this.rows.get(line.key) : undefined;
      if (!line || !old) continue;
      const sel = selectionPart(next, r);
      if (!sameSelection(old, sel)) this.setRow(line.key, { ...old, ...sel });
    }
  }

  // ── Announcements ─────────────────────────────────────────────────────────
  announce(text: string): void { this.setMeta({ announcement: { seq: this.meta.announcement.seq + 1, text } }); }
  setNotice(notice: readonly InvalidCellNotice[] | null): void { this.setMeta({ notice: notice && notice.length > 0 ? notice : null }); }
  dismissNotice = (): void => { this.setNotice(null); };
}
