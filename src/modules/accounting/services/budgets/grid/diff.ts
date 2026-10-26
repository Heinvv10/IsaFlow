/**
 * Cell maps compared: the Excel import diff (spec §9.2) and the 409 rebase
 * (spec §7.3). Values are cents; `null` or a missing key is "not budgeted".
 *
 * Import rules: a blank cell clears, 0 is a budgeted zero, and a key absent
 * from the file is untouched. Invariant 3 (export → import = no changes) holds
 * because the template is `gridOf` the version and the import reads blanks back
 * as null.
 */
import type { CellKey } from './cellKey';

export type CellMap = ReadonlyMap<CellKey, number | null>;

export interface CellChange {
  key: CellKey;
  before: number | null;
  after: number | null;
}

export interface DiffCounts { added: number; changed: number; cleared: number; unchanged: number }
export interface DiffResult { changes: CellChange[]; counts: DiffCounts }

const valueIn = (m: CellMap, key: CellKey): number | null => m.get(key) ?? null;

export function diffCells(base: CellMap, incoming: CellMap, mode: 'import'): DiffResult {
  void mode; // the one mode P2 has; named at the call site so a later mode is a visible choice
  const changes: CellChange[] = [];
  const counts: DiffCounts = { added: 0, changed: 0, cleared: 0, unchanged: 0 };
  for (const [key, after] of incoming) {
    const before = valueIn(base, key);
    if (before === after) { counts.unchanged++; continue; }
    changes.push({ key, before, after });
    if (before === null) counts.added++;
    else if (after === null) counts.cleared++;
    else counts.changed++;
  }
  return { changes, counts };
}

/**
 * Every (row × month) cell for `rowKeys` (a cell key without its month,
 * `cellKey.rowKeyOf`), valued from `base`, null where not budgeted: the grid a
 * template exports.
 */
export function gridOf(rowKeys: readonly string[], months: readonly string[], base: CellMap): Map<CellKey, number | null> {
  const out = new Map<CellKey, number | null>();
  for (const row of rowKeys) for (const m of months) out.set(`${row}|${m}`, valueIn(base, `${row}|${m}`));
  return out;
}

export interface RebaseResult {
  /** Fresh values with my edits laid over them. */
  values: Map<CellKey, number | null>;
  /** My edits that still differ from fresh: what the next save sends. */
  dirty: Map<CellKey, number | null>;
  /** Keys I edited that someone else changed since I loaded (fresh ≠ my original). */
  conflicts: CellKey[];
}

export function rebaseDirty(original: CellMap, fresh: CellMap, dirty: CellMap): RebaseResult {
  const values = new Map<CellKey, number | null>(fresh);
  const stillDirty = new Map<CellKey, number | null>();
  const conflicts: CellKey[] = [];
  for (const [key, mine] of dirty) {
    const now = valueIn(fresh, key);
    if (now !== valueIn(original, key)) conflicts.push(key);
    values.set(key, mine);
    if (mine !== now) stillDirty.set(key, mine);
  }
  return { values, dirty: stillDirty, conflicts };
}
