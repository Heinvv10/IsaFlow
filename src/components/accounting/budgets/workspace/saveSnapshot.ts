/**
 * Store cells ↔ the save route's shape (PR-B contract): rand rounded to cents on the wire, and a
 * delete is `amount: null, clear: true` (a bare null is refused by the server).
 */
import { type CellKey, cellKey, parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { fromCents } from '@/modules/accounting/services/budgets/grid/cents';
import type { SaveCell } from './budgetWorkspaceClient';

export function toSaveCells(cells: ReadonlyMap<CellKey, number | null>): SaveCell[] {
  return [...cells].map(([key, cents]) => {
    const ref = parseKey(key);
    return cents === null ? { ...ref, amount: null, clear: true } : { ...ref, amount: fromCents(cents) };
  });
}

/** The part of `snapshot` that `committed` (chunks a chained save got through) carried. */
export function committedPart(snapshot: ReadonlyMap<CellKey, number | null>, committed: readonly SaveCell[]): Map<CellKey, number | null> {
  const out = new Map<CellKey, number | null>();
  for (const c of committed) {
    const key = cellKey(c);
    if (snapshot.has(key)) out.set(key, snapshot.get(key) ?? null);
  }
  return out;
}
