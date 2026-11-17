/**
 * bankTxEditTracker - what a refused row save puts back (WP3). The grid shows an edit the moment it is made, so a save the
 * server refuses must undo it - to the last value the SERVER is known to hold, never to a snapshot of an edit that was
 * itself never stored (X, then Y, both refused: back to the original, not to X).
 *
 * State is kept per row per field GROUP (the allocation: type, entity, label, VAT; the cost centres), so an edit to one group
 * never blocks or reverts the other. Per group: `seq` (the newest edit: an older edit failing late no longer owns the row, even
 * if the user re-picked its very value), `baseline` (the last known saved values) and `pending` (edits not yet answered).
 * The entry is dropped when its last pending edit settles, so the map does not grow with the session.
 */

import type { RowSelection } from '@/components/accounting/BankTxTable';

const DIM_KEYS = ['cc1Id', 'cc2Id', 'buId'] as const;
const ALLOC_KEYS = ['type', 'entityId', 'label', 'vatCode'] as const;
type Group = 'alloc' | 'dims';
const groupOf = (k: keyof RowSelection): Group => ((DIM_KEYS as readonly string[]).includes(k) ? 'dims' : 'alloc');
const groupKeys = (g: Group): ReadonlyArray<keyof RowSelection> => (g === 'dims' ? DIM_KEYS : ALLOC_KEYS);
/** What an allocation field is when the row had no selection. */
const EMPTY: Partial<RowSelection> = { type: 'account', entityId: '', label: '', vatCode: 'none' };

interface GroupState { seq: number; pending: number; baseline: Record<string, unknown>; noRow: boolean }
const states = new Map<string, GroupState>();
/** Open entries (for tests and diagnostics). */
export const trackedEditCount = (): number => states.size;

type SetRows = (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void;

export function trackEdit(txId: string, before: RowSelection | undefined, patch: Partial<RowSelection>, setRowSelections: SetRows) {
  const keys = Object.keys(patch) as Array<keyof RowSelection>;
  const groups = Array.from(new Set(keys.map(groupOf)));
  const seqs = new Map<Group, number>();
  for (const g of groups) {
    let st = states.get(`${txId}:${g}`);
    if (!st) {
      st = { seq: 0, pending: 0, noRow: !before, baseline: Object.fromEntries(groupKeys(g).map(k => [k, before ? before[k] : EMPTY[k]])) };
      states.set(`${txId}:${g}`, st);
    }
    st.seq += 1; st.pending += 1; seqs.set(g, st.seq);
  }
  const settle = (g: Group) => {
    const st = states.get(`${txId}:${g}`);
    if (st && --st.pending <= 0) states.delete(`${txId}:${g}`);
  };

  /** The save was stored: its values are now the baseline a later refusal falls back to. */
  const saved = () => {
    for (const g of groups) {
      const st = states.get(`${txId}:${g}`);
      if (st) for (const k of keys) if (groupOf(k) === g) st.baseline[k] = patch[k];
      settle(g);
    }
  };

  /** The save was refused: put back the groups this edit still owns, to their baseline. */
  const rollback = () => {
    const snap = new Map<Group, { owns: boolean; baseline: Record<string, unknown>; noRow: boolean }>();
    for (const g of groups) {
      const st = states.get(`${txId}:${g}`);
      snap.set(g, { owns: !!st && st.seq === seqs.get(g), baseline: { ...(st?.baseline ?? {}) }, noRow: !!st?.noRow });
      settle(g);
    }
    setRowSelections(prev => {
      const cur = prev[txId];
      if (!cur) return prev;
      const restore = keys.filter(k => {
        const s = snap.get(groupOf(k))!;
        return s.owns && keys.filter(o => groupOf(o) === groupOf(k)).every(o => cur[o] === patch[o]);
      });
      if (restore.length === 0) return prev;
      const row: RowSelection = { ...cur };
      for (const k of restore) (row as unknown as Record<string, unknown>)[k] = snap.get(groupOf(k))!.baseline[k];
      const next = { ...prev };
      if (snap.get('alloc')?.noRow && !row.entityId && !DIM_KEYS.some(k => row[k])) delete next[txId];
      else next[txId] = row;
      return next;
    });
  };

  return { rollback, saved };
}
