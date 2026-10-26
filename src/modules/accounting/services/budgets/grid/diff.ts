/**
 * Cell maps compared: the Excel import diff (spec §9.2) and the 409 rebase
 * (spec §7.3). Values are cents; `null` or a missing key is "not budgeted".
 *
 * Import rules: a blank cell clears, 0 is a budgeted zero, and a key absent
 * from the file is untouched. Invariant 3 (export → import = no changes) holds
 * because the template is `gridOf` the version and the import reads blanks back
 * as null. Values must be whole cents within NUMERIC(15,2); anything else is a
 * caller bug and throws.
 */
import { type CellKey, grainOf, parseKey } from './cellKey';
import { isCents } from './cents';
import { accountGrains } from './pivot';
import type { Change } from './undo';

export type CellMap = ReadonlyMap<CellKey, number | null>;
export type CellChange = Change;

export interface DiffCounts { added: number; changed: number; cleared: number; unchanged: number }
export interface DiffResult { changes: CellChange[]; counts: DiffCounts }

function valueIn(m: CellMap, key: CellKey): number | null {
  const v = m.get(key) ?? null;
  if (v !== null && !isCents(v)) throw new RangeError(`Not a budget amount in cents at ${key}: ${v}`);
  return v;
}

export function diffCells(base: CellMap, incoming: CellMap): DiffResult {
  const changes: CellChange[] = [];
  const counts: DiffCounts = { added: 0, changed: 0, cleared: 0, unchanged: 0 };
  for (const key of incoming.keys()) {
    const after = valueIn(incoming, key);
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
 * template exports. Each key is validated by `parseKey`.
 */
export function gridOf(rowKeys: readonly string[], months: readonly string[], base: CellMap): Map<CellKey, number | null> {
  const out = new Map<CellKey, number | null>();
  for (const row of rowKeys) {
    for (const m of months) {
      const key = `${row}|${m}`;
      parseKey(key);
      out.set(key, valueIn(base, key));
    }
  }
  return out;
}

export interface RebaseResult {
  /** Fresh values with my edits laid over them. */
  values: Map<CellKey, number | null>;
  /** My edits that still differ from fresh: what the next save sends. */
  dirty: Map<CellKey, number | null>;
  /**
   * Keys I edited that someone else changed to a different value since I loaded
   * (fresh ≠ my original and ≠ mine), plus every key I edited on an account whose
   * grain someone else changed to one other than my key's (company ↔ dimension):
   * saving those would be refused by the one-grain rule, so the dialog must show them.
   */
  conflicts: CellKey[];
}

export function rebaseDirty(original: CellMap, fresh: CellMap, dirty: CellMap): RebaseResult {
  const values = new Map<CellKey, number | null>(fresh);
  const stillDirty = new Map<CellKey, number | null>();
  const conflicts: CellKey[] = [];
  const before = accountGrains(original);
  const now = accountGrains(fresh);
  for (const key of dirty.keys()) {
    const mine = valueIn(dirty, key);
    const current = valueIn(fresh, key);
    const ref = parseKey(key);
    const g = grainOf(ref);
    const theirs = now.get(ref.glAccountId);
    // A clear of mine that fresh already shows as empty is no conflict, whatever the grain did.
    const settled = mine === null && current === null;
    const regrained = !settled && theirs !== undefined && theirs !== before.get(ref.glAccountId) && theirs !== (g === 'multi' ? 'mixed' : g);
    if (regrained || (current !== valueIn(original, key) && current !== mine)) conflicts.push(key);
    values.set(key, mine);
    if (mine !== current) stillDirty.set(key, mine);
  }
  return { values, dirty: stillDirty, conflicts };
}
