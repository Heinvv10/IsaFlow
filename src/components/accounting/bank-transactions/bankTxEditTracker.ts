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

interface GroupState {
  seq: number; pending: number; baseline: Record<string, unknown>; noRow: boolean;
  /** The NEWEST edit was refused while an older one was still in flight: its answer decides, so the put-back waits for it. */
  deferred: Partial<RowSelection> | null;
}
const states = new Map<string, GroupState>();
/** Open entries (for tests and diagnostics). */
export const trackedEditCount = (): number => states.size;

type SetRows = (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void;

/** Puts `restoreKeys` of the row back to `baseline`, but only while the row still shows `patch`; drops a row that is empty again. */
function putBack(setRowSelections: SetRows, txId: string, patch: Partial<RowSelection>, restoreKeys: Array<keyof RowSelection>,
  baseline: Record<string, unknown>, emptied: boolean) {
  setRowSelections(prev => {
    const cur = prev[txId];
    if (!cur) return prev;
    const groups = new Set(restoreKeys.map(groupOf));
    const owned = restoreKeys.filter(k => groups.has(groupOf(k)));
    if (owned.length === 0 || (Object.keys(patch) as Array<keyof RowSelection>).some(o => groups.has(groupOf(o)) && cur[o] !== patch[o])) return prev;
    const row: RowSelection = { ...cur };
    for (const k of owned) (row as unknown as Record<string, unknown>)[k] = baseline[k];
    const next = { ...prev };
    if (emptied && !row.entityId && !DIM_KEYS.some(k => row[k])) delete next[txId];
    else next[txId] = row;
    return next;
  });
}

export function trackEdit(txId: string, before: RowSelection | undefined, patch: Partial<RowSelection>, setRowSelections: SetRows) {
  const keys = Object.keys(patch) as Array<keyof RowSelection>;
  const groups = Array.from(new Set(keys.map(groupOf)));
  const seqs = new Map<Group, number>();
  for (const g of groups) {
    let st = states.get(`${txId}:${g}`);
    if (!st) {
      st = { seq: 0, pending: 0, noRow: !before, deferred: null, baseline: Object.fromEntries(groupKeys(g).map(k => [k, before ? before[k] : EMPTY[k]])) };
      states.set(`${txId}:${g}`, st);
    }
    st.seq += 1; st.pending += 1; seqs.set(g, st.seq);
  }
  const keysOf = (g: Group) => keys.filter(k => groupOf(k) === g);

  /** One answer in: when it was the last in flight, a deferred put-back of the newest (refused) edit is carried out now. */
  const settle = (g: Group) => {
    const st = states.get(`${txId}:${g}`);
    if (!st) return;
    st.pending -= 1;
    if (st.pending > 0) return;
    states.delete(`${txId}:${g}`);
    if (st.deferred) putBack(setRowSelections, txId, st.deferred, (Object.keys(st.deferred) as Array<keyof RowSelection>).filter(k => groupOf(k) === g), { ...st.baseline }, st.noRow);
  };

  /** The save was stored: its values are now the baseline a later refusal falls back to. */
  const saved = () => {
    for (const g of groups) {
      const st = states.get(`${txId}:${g}`);
      if (st) for (const k of keysOf(g)) st.baseline[k] = patch[k];
      settle(g);
    }
  };

  /**
   * The save was refused. If this is still the newest edit of a group and nothing older is in flight, the group goes back to
   * the last stored values now. If an older edit is still in flight the server may yet hold THAT value, so the put-back waits
   * for its answer (the newest in-flight edit's answer decides). An edit that is no longer the newest owns nothing.
   */
  const rollback = () => {
    const now: Array<keyof RowSelection> = [];
    const baseline: Record<string, unknown> = {};
    let emptied = false;
    for (const g of groups) {
      const st = states.get(`${txId}:${g}`);
      if (st && st.seq === seqs.get(g)) {
        if (st.pending > 1) st.deferred = { ...(st.deferred ?? {}), ...Object.fromEntries(keysOf(g).map(k => [k, patch[k]])) };
        else { now.push(...keysOf(g)); Object.assign(baseline, st.baseline); emptied ||= st.noRow; }
      }
      settle(g);
    }
    // One update for everything this edit puts back (the allocation and the cost centres together).
    if (now.length > 0) putBack(setRowSelections, txId, patch, now, baseline, emptied);
  };

  return { rollback, saved };
}
