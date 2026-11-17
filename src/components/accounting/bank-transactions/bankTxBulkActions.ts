/**
 * bankTxBulkActions - the bulk handlers of the bank-transactions page (WP3), split out of useBankTxActions
 * (300-line rule). Every one acts ONLY on the rows on screen (`selected` is already the selection intersected with the
 * loaded rows), refuses a second click while it runs (`run`), and says what really happened:
 *  - Delete reports the server's `{deleted}` and the rows it refused, not the number asked for;
 *  - Batch Allocate shows progress ("Allocating 3 of 12") - it stays a request per line (each posts its own journal and
 *    can be refused on its own), so progress, not one request, is the honest design;
 *  - Mark as Reviewed reports `accepted` of the rows sent.
 */

import { apiErrorMessage } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';
import { actionableIds } from './pendingFeedRow';
import type { BankTxBusy } from './useBankTxBusy';

type CallAction = (body: Record<string, string>, fallback?: string) => Promise<{ data?: { deleted?: number; accepted?: number; lateClaim?: unknown } } & Record<string, unknown>>;

export interface BulkDeps {
  transactions: BankTx[];
  /** The selection restricted to rows on screen. */
  selected: Set<string>;
  rowSelections: Record<string, RowSelection>;
  callAction: CallAction;
  run: BankTxBusy['run'];
  setProgress: BankTxBusy['setProgress'];
  setSelectedIds: (fn: (prev: Set<string>) => Set<string>) => void;
  /** The list and the summary, once. */
  reload: () => void;
  /** Takes lines that left the tab off the screen at once (the reload that follows only tops the page up). */
  removeRows?: (ids: string[]) => void;
}

export function buildBulkActions(d: BulkDeps) {
  const { transactions, selected, rowSelections, callAction, run, setProgress, setSelectedIds, reload, removeRows } = d;
  const rows = Array.from(selected); // the lines these operations touch: a row action on one of them is refused meanwhile
  // Only the lines this batch handled are un-ticked: a tick made on another page meanwhile is the user's, and stays.
  const done = () => { setSelectedIds(prev => { const next = new Set(prev); rows.forEach(id => next.delete(id)); return next; }); reload(); };

  const handleBatchAccept = () => run('batch-allocate', async () => {
    const actionable = actionableIds(transactions, Array.from(selected));
    const toAccept = actionable.filter(id => rowSelections[id]?.entityId);
    if (actionable.length === 0 && selected.size > 0) { notify.error("Pending transactions can't be processed until they post."); return; }
    if (toAccept.length === 0) { notify.error('Select transactions with accounts assigned'); return; }
    let ok = 0, fail = 0, firstReason = '';
    const okIds: string[] = [];
    const late: unknown[] = [];
    for (const [i, txId] of toAccept.entries()) {
      setProgress({ key: 'batch-allocate', done: i, total: toAccept.length });
      try {
        const sel = rowSelections[txId];
        if (!sel) continue;
        const body: Record<string, string> = { action: 'allocate', bankTransactionId: txId, allocationType: sel.type, vatCode: sel.vatCode || 'none', autoApply: 'fifo' };
        if (sel.type === 'account' || sel.type === 'transfer') body.contraAccountId = sel.entityId;
        else body.entityId = sel.entityId;
        // Dimensions belong on the cost line only: a supplier payment, receipt or transfer carries none (the server refuses them).
        if (sel.type === 'account') {
          if (sel.cc1Id) body.cc1Id = sel.cc1Id;
          if (sel.cc2Id) body.cc2Id = sel.cc2Id;
          if (sel.buId) body.buId = sel.buId;
        }
        late.push((await callAction(body))?.data?.lateClaim); ok++; okIds.push(txId);
      } catch (e) { fail++; firstReason ||= apiErrorMessage(e, 'Could not allocate the transaction - try again'); }
    }
    setProgress(null);
    if (ok === 0) notify.error(`No transactions were allocated: ${firstReason}`);
    else if (fail) notify.warning(`${ok} allocated, ${fail} could not be allocated`, firstReason);
    else notify.success(`${ok} allocated`);
    notifyLateClaims({ data: { results: late.map((lateClaim) => ({ lateClaim })) } });
    removeRows?.(okIds);
    done();
  }, rows);

  const handleBatchDelete = () => run('delete', async () => {
    if (selected.size === 0) return;
    const toDelete = actionableIds(transactions, Array.from(selected));
    if (toDelete.length === 0) { notify.error("Pending transactions can't be processed until they post."); return; }
    if (!window.confirm(`Delete ${toDelete.length} transaction(s)? This cannot be undone.`)) return;
    try {
      const res = await callAction({ action: 'delete', bankTransactionIds: toDelete } as unknown as Record<string, string>);
      // The server's count, not the number asked for: it deletes only lines still awaiting allocation.
      const deleted = Number(res?.data?.deleted);
      if (!Number.isFinite(deleted)) notify.warning('Delete finished, but the server did not say how many lines it removed', 'Check the list.');
      else if (deleted === 0) notify.error(`Nothing was deleted: the ${toDelete.length} line(s) are no longer awaiting allocation`);
      else if (deleted < toDelete.length) notify.warning(`${deleted} of ${toDelete.length} transaction(s) deleted`, `${toDelete.length - deleted} were refused: already allocated, reconciled or no longer there.`);
      else notify.success(`${deleted} transaction(s) deleted`);
      if (deleted === toDelete.length) removeRows?.(toDelete);
      done();
    } catch (e) { notify.error(apiErrorMessage(e, 'Could not delete the transactions - try again')); }
  }, rows);

  const handleBulkAccept = () => run('review', async () => {
    if (selected.size === 0) return;
    const toAccept = actionableIds(transactions, Array.from(selected));
    if (toAccept.length === 0) { notify.error("Pending transactions can't be processed until they post."); return; }
    try {
      const json = await callAction({ action: 'bulk_accept', bankTransactionIds: toAccept } as unknown as Record<string, string>, 'Could not mark the transactions as reviewed - try again');
      const accepted: number = json.data?.accepted ?? toAccept.length;
      if (accepted < toAccept.length) notify.warning(`${accepted} of ${toAccept.length} transaction(s) marked as reviewed`, `${toAccept.length - accepted} were already reviewed or have no journal yet - allocate the line (Undo it first if it shows as matched) before reviewing it`);
      else notify.success(`${accepted} transaction(s) marked as reviewed`);
      if (accepted === toAccept.length) removeRows?.(toAccept);
      done();
    } catch (e) { notify.error(apiErrorMessage(e, 'Could not mark as reviewed - try again')); }
  }, rows);

  return { handleBatchAccept, handleBatchDelete, handleBulkAccept };
}
