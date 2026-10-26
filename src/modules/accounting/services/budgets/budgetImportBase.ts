/**
 * The import's 3-way diff (budgets P2 PR-B, ruling R1). The template carries, in its hidden
 * `_base` sheet, every row's amounts as downloaded (cents). A cell is a CHANGE only where the file
 * differs from that base; a cell the user left as downloaded is untouched even if the version has
 * moved on since (no silent revert of a colleague's save). A cell the user changed that also
 * changed in the version is a CONFLICT: listed, and still applied as the user's value (PR-A
 * `rebaseDirty`'s rule). A row in the file with no `_base` row (added by the user) is diffed
 * against blank. `_base` is machine-written: anything that does not read back exactly is refused
 * 400 "re-download".
 */
import { MAX_CENTS } from './grid/cents';
import type { CellKey } from './grid/cellKey';
import { rebaseDirty, type CellChange, type CellMap, type DiffCounts } from './grid/diff';
import { inputError } from './gridErrors';
import { COLUMN, type TemplateGrain } from './budgetTemplateXlsx';
import { codeOf, textOf, type SheetRow } from './budgetImportParse';

/** `_base` rows by line key: each year month's downloaded cents, null where not budgeted. */
export type BaseRows = Map<string, Array<number | null>>;

/** A file row's identity in `_base`: its account code and, at a dimension grain, its member code. */
export const lineKey = (accountCode: string, dimensionCode: string | null): string => `${accountCode}\u0000${dimensionCode ?? ''}`;

export const tampered = (): never => {
  throw inputError('This template\'s hidden _base sheet is missing or was changed, so IsaFlow cannot tell what you edited. Re-download the template and enter your amounts in that.');
};

/** The `_base` sheet: a header of exactly the template's code columns and year months, then integer-cent rows. */
export function parseBase(rows: readonly SheetRow[], months: readonly string[], grain: TemplateGrain): BaseRows {
  const [header, ...data] = rows;
  const codes = grain === 'company' ? [COLUMN.accountCode] : [COLUMN.accountCode, COLUMN.dimensionCode];
  const expected = [...codes, ...months];
  const texts = (header?.cells ?? []).map(textOf);
  if (expected.some((t, i) => texts[i] !== t) || texts.slice(expected.length).some((t) => t !== '')) return tampered();
  const out: BaseRows = new Map();
  for (const r of data) {
    const accountCode = codeOf(r.cells[0]);
    const dimensionCode = grain === 'company' ? null : codeOf(r.cells[1]);
    if (accountCode === '' || dimensionCode === '' || r.cells.slice(expected.length).some((c) => c !== null)) return tampered();
    const key = lineKey(accountCode, dimensionCode);
    if (out.has(key)) return tampered();
    out.set(key, months.map((_, i) => {
      const c = r.cells[codes.length + i];
      if (c === null || c === undefined) return null;
      return typeof c === 'number' && Number.isSafeInteger(c) && Math.abs(c) <= MAX_CENTS ? c : tampered();
    }));
  }
  return out;
}

/** One file row to diff: its cell-key row, its downloaded cents (null for a row the user added), its cents now in the file. */
export interface DiffRow { rowKey: string; base: ReadonlyArray<number | null> | null; file: ReadonlyArray<number | null> }

export interface Conflict { key: CellKey; downloaded: number | null; current: number | null; after: number | null }

export interface ThreeWay {
  changes: CellChange[];
  conflicts: Conflict[];
  counts: DiffCounts;
  /** Cells of the rows with a `_base` row whose value now differs from the downloaded one. */
  moved: number;
}

/** The 3-way diff of `rows` (cents) against `current`, the version's cells now. */
export function threeWay(rows: readonly DiffRow[], months: readonly string[], current: CellMap): ThreeWay {
  const original = new Map<CellKey, number | null>();
  const dirty = new Map<CellKey, number | null>();
  let total = 0, moved = 0;
  for (const r of rows) {
    months.forEach((m, i) => {
      const key = `${r.rowKey}|${m}`;
      const base = r.base?.[i] ?? null;
      const file = r.file[i] ?? null;
      total++;
      if (base !== null) original.set(key, base);
      if (r.base && (current.get(key) ?? null) !== base) moved++;
      if (file !== base) dirty.set(key, file);
    });
  }
  const rebased = rebaseDirty(original, current, dirty);
  const changes: CellChange[] = [...rebased.dirty].map(([key, after]) => ({ key, before: current.get(key) ?? null, after }));
  const counts: DiffCounts = { added: 0, changed: 0, cleared: 0, unchanged: total - changes.length };
  for (const c of changes) {
    if (c.before === null) counts.added++;
    else if (c.after === null) counts.cleared++;
    else counts.changed++;
  }
  const conflicts = rebased.conflicts.map((key) => ({
    key, downloaded: original.get(key) ?? null, current: current.get(key) ?? null, after: dirty.get(key) ?? null,
  }));
  return { changes, conflicts, counts, moved };
}
