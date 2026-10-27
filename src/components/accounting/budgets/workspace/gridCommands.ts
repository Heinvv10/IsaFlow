/**
 * The grid's write commands (spec §5.2, §5.3, §5.5), shared by the keyboard and clipboard hooks.
 * Each user action is ONE `store.apply` (one undo entry) and one announcement for the live
 * region. Amounts go through PR-A `parseCell` (the kit's `parseSaAmount`): a refused amount is
 * announced and never written. Paste / fill / copy positions are PR-A's (`pasteInto`, `fillDown`,
 * `fillRight`, `copyMatrix`); the FY-total commit is PR-A `spreadEven`.
 */
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { type CellWrite, copyMatrix, fillDown, fillRight, pasteInto } from '@/modules/accounting/services/budgets/grid/fill';
import { parseCell, parseClipboard } from '@/modules/accounting/services/budgets/grid/pasteParse';
import { type Pos, type Rect, clampToEditable } from '@/modules/accounting/services/budgets/grid/selection';
import { residueFlipsSign, spreadEven } from '@/modules/accounting/services/budgets/grid/spread';
import { toTsv } from '@/modules/accounting/services/budgets/grid/tsv';
import type { CellWriteByKey, GridStore } from './gridStore';

const cells = (n: number): string => `${n} cell${n === 1 ? '' : 's'}`;

function byKey(store: GridStore, writes: readonly CellWrite[]): CellWriteByKey[] {
  const out: CellWriteByKey[] = [];
  for (const w of writes) {
    const key = store.cellKeyAt(w.pos);
    if (key) out.push({ key, cents: w.cents });
  }
  return out;
}

/**
 * Commit an edit draft. The FY total column spreads the typed total evenly with `unit` (decision 5);
 * when the unit pushes the last month across zero the spread still applies and a notice says so.
 * Returns the refusal reason (nothing written), or null when the draft was taken.
 */
export function commitDraft(store: GridStore, pos: Pos, draft: string, isTotal: boolean, unit: RoundingUnit): string | null {
  const months = store.getLayout().months;
  if (!store.isEditable(pos)) { const why = store.readReason(pos) ?? 'Read-only'; store.announce(why); return why; }
  const cell = parseCell(draft);
  if (cell.kind === 'error') { store.announce(`Not changed: ${cell.reason}`); return cell.reason; }
  const cents = cell.kind === 'blank' ? null : cell.cents;
  if (!isTotal && pos.c < months.length) {
    const key = store.cellKeyAt(pos);
    if (key) store.apply([{ key, cents }]);
    return null;
  }
  const keys = months.map((_, c) => store.cellKeyAt({ r: pos.r, c }));
  if (cents === null) {
    store.apply(keys.flatMap(key => (key ? [{ key, cents: null }] : [])));
    return null;
  }
  const spread = spreadEven(cents, months.length, unit);
  if (!spread.ok) { store.announce(`Not changed: ${spread.reason}`); return spread.reason; }
  store.apply(keys.flatMap((key, i) => (key ? [{ key, cents: spread.months[i] ?? 0 }] : [])));
  if (residueFlipsSign(cents, spread.months)) {
    const reason = `The R${unit} rounding leaves the last month on the other side of zero; use a smaller rounding unit or edit the months.`;
    store.addNotice([{ rowLabel: store.rowLabel(pos.r), monthLabel: monthLabel(months[months.length - 1] ?? ''), raw: draft, reason, cells: 1 }]);
    store.announce(reason);
  }
  return null;
}

export function clearCells(store: GridStore, positions: readonly Pos[]): void {
  const n = store.apply(byKey(store, positions.filter(store.isEditable).map(pos => ({ pos, cents: null }))));
  store.announce(n === 0 ? 'Nothing to clear' : `Cleared ${cells(n)}`);
}

export function fillCells(store: GridStore, dir: 'down' | 'right', rect: Rect): void {
  const grid = store.fillGrid();
  const res = dir === 'down' ? fillDown(rect, grid) : fillRight(rect, grid);
  store.apply(byKey(store, res.writes));
  store.announce(`Filled ${cells(res.writes.length)}${res.skipped > 0 ? `; ${res.skipped} skipped (read-only)` : ''}`);
}

/** The selection as TSV (line rows × month columns; blank where not budgeted). */
export function copyText(store: GridStore, rect: Rect): string {
  return toTsv(copyMatrix(rect, store.fillGrid()));
}

/** Copy, then clear the selection's editable month cells as one undo entry. */
export function cutText(store: GridStore, rect: Rect): string {
  const text = copyText(store, rect);
  const months = store.getLayout().months.length;
  const targets = clampToEditable({ ...rect, right: Math.min(rect.right, months - 1) }, store.getShape(), store.isEditable);
  const n = store.apply(byKey(store, targets.map(pos => ({ pos, cents: null }))));
  store.announce(`Cut ${cells(n)}`);
  return text;
}

/** Paste clipboard text at `rect` (spec §5.3): one undo entry; refused cells listed in the notice. */
export function pasteText(store: GridStore, rect: Rect, text: string): void {
  const parsed = parseClipboard(text);
  if (parsed.tooLarge) { store.announce('The clipboard holds too much to paste at once.'); return; }
  if (parsed.rows.length === 0) { store.announce('Nothing to paste'); return; }
  const res = pasteInto(rect, parsed.rows, store.fillGrid());
  store.apply(byKey(store, res.writes));
  const months = store.getLayout().months;
  // pasteInto drops clipboard cells that land below the last line row or right of the FY column
  // without a word: what it neither wrote, skipped nor refused fell off the grid. (A 1×1 paste fills
  // the selection, so it accounts for at least its one cell and never counts as clipped.)
  const sent = parsed.rows.reduce((n, cols) => n + cols.length, 0);
  const clipped = Math.max(0, sent - res.writes.length - res.skipped - res.invalid.length);
  const notice = res.invalid.map(i => ({
    rowLabel: store.rowLabel(i.pos.r), monthLabel: monthLabel(months[i.pos.c] ?? ''), raw: i.raw, reason: i.reason, cells: 1,
  }));
  if (clipped > 0) {
    notice.push({ rowLabel: 'Past the end of the grid', monthLabel: '', raw: '', cells: clipped, reason: clipped === 1
      ? '1 pasted cell fell past the end of the grid and was not pasted.'
      : `${clipped} pasted cells fell past the end of the grid and were not pasted.` });
  }
  store.setNotice(notice);
  let message = `Pasted ${cells(res.writes.length)}`;
  if (res.skipped > 0) message += `; ${res.skipped} skipped (read-only)`;
  if (res.invalid.length > 0) message += `; ${res.invalid.length} not a number (left unchanged)`;
  if (clipped > 0) message += `; ${clipped} not pasted (past the end of the grid)`;
  store.announce(message);
}

export function undoLast(store: GridStore): boolean {
  const n = store.undo();
  store.announce(n === 0 ? 'Nothing to undo' : `Undid ${n} change${n === 1 ? '' : 's'}`);
  return n > 0;
}

export function redoLast(store: GridStore): boolean {
  const n = store.redo();
  store.announce(n === 0 ? 'Nothing to redo' : `Redid ${n} change${n === 1 ? '' : 's'}`);
  return n > 0;
}
