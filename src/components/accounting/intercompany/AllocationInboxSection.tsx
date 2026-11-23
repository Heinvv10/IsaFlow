/**
 * Bills > Intercompany, "Payments from your group" (P4-C): the payments a payer in the group applied to bills linked to this company's
 * invoices, under the invoice list, shown only when there is one. Each row says whether the payer's books still say what it says (Live /
 * Stale: <reason>) and what does not fit this company's invoice (Check: <mismatch>). Read only: Reject (a reason is required), Dismiss (asked
 * first) and Restore of a dismissed one; there is NO Accept (clearing comes later, P4-D). Every action button and notice names its row by
 * payment and invoice. A failed reload keeps the list (and any open dialog) with an alert above it; a 409 reloads the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ApiRequestError, apiErrorMessage, apiJson } from '@/lib/apiFetch';
import type { InboxFilter } from '@/modules/accounting/services/intercompany/inboxTypes';
import type { AllocationItem, AllocationPage } from '@/modules/accounting/services/intercompany/allocationInboxTypes';
import { AllocationDetailDrawer } from './AllocationDetailDrawer';
import { InboxRejectModal } from './InboxRejectModal';
import { AllocationRow } from './AllocationRow';
import { rowLabels } from './allocationLabels';

interface Props {
  filter: InboxFilter;
  canWrite: boolean;
  onNotice: (n: { msg: string; ok: boolean }) => void;
  /** How many payments the last answer listed (not reported while a list loads): the invoice list words its empty state by it. */
  onCount?: (n: number) => void;
}

const LIMIT = 100;
const COLUMNS = ['Payer', 'Payment', 'Your invoice', 'Amount', 'Open amount', 'State'];
const LOAD_ERROR = 'Could not load the payments from your group - try again';
const isConflict = (err: unknown) => err instanceof ApiRequestError && err.status === 409;

export function AllocationInboxSection({ filter, canWrite, onNotice, onCount }: Props) {
  const [page, setPage] = useState<AllocationPage | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<AllocationItem | null>(null);
  const [rejecting, setRejecting] = useState<AllocationItem | null>(null);
  const [confirming, setConfirming] = useState<AllocationItem | null>(null);
  // Per row: an action in flight on one row leaves the others usable.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Only the newest load may write state: a slow answer for the other filter must not replace this one.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiJson(`/api/accounting/intercompany/allocations?filter=${filter}&limit=${LIMIT}&offset=0`, undefined, LOAD_ERROR);
      if (mine !== latest.current) return;
      setPage(result);
      setError('');
    } catch (err) {
      // the last list stays (and so does any open dialog): the alert says the reload failed
      if (mine === latest.current) setError(apiErrorMessage(err, LOAD_ERROR));
    }
  }, [filter]);

  useEffect(() => { setPage(null); setError(''); void load(); }, [load]);
  useEffect(() => { if (page) onCount?.(page.items.length); }, [onCount, page]);

  const mark = (id: string, on: boolean) => setBusy((b) => { const n = new Set(b); if (on) n.add(id); else n.delete(id); return n; });

  async function act(item: AllocationItem, what: 'dismiss' | 'restore', done: string) {
    mark(item.id, true);
    try {
      await apiJson(`/api/accounting/intercompany/allocations/${item.id}/${what}`, { method: 'POST' }, `Could not ${what} this payment - try again`);
      setOpen(null);
      onNotice({ msg: done, ok: true });
      await load();
    } catch (err) {
      onNotice({ msg: apiErrorMessage(err, `Could not ${what} this payment - try again`), ok: false });
      if (isConflict(err)) void load();     // someone else moved it: show it as it now is
    } finally {
      mark(item.id, false);
    }
  }

  const items = page?.items ?? [];
  const labels = rowLabels(items);
  const labelOf = (i: AllocationItem) => labels.get(i.id) ?? i.id;
  const alert = error && (
    <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden /><span className="flex-1">Payments from your group: {error}</span>
      <button type="button" onClick={() => void load()} className="underline">Try again</button>
    </div>
  );
  if (items.length === 0) return alert || null;

  return (
    <>
      {alert}
      <section aria-labelledby="ic-allocations-heading" className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 id="ic-allocations-heading" className="text-base font-semibold text-ink">Payments from your group</h2>
          <p className="text-sm text-ink-muted">
            Payments a company in your group applied to bills linked to your invoices. Clearing them against your invoices is coming; for now you can reject or dismiss one. Nothing here changes your books.
          </p>
        </div>
        <table className="table-cards w-full text-sm" data-testid="allocation-table">
          <caption className="sr-only">Payments from your group: payer, payment, your invoice, amount, open amount and state</caption>
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
            <tr>
              {COLUMNS.map((h, k) => (
                <th key={h} className={`px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wider ${k === 3 || k === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}
              <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((i) => (
              <AllocationRow key={i.id} item={i} label={labelOf(i)} canWrite={canWrite} busy={busy.has(i.id)} onDetails={() => setOpen(i)}
                onReject={() => setRejecting(i)} onDismiss={() => setConfirming(i)}
                onRestore={() => void act(i, 'restore', `Restored ${labelOf(i)}.`)} />
            ))}
          </tbody>
        </table>
        {page && page.total > items.length && (
          <p className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 text-sm text-ink-muted">Showing the latest {items.length} of {page.total}.</p>
        )}
        <AllocationDetailDrawer item={open} label={open ? labelOf(open) : ''} canWrite={canWrite} busy={open !== null && busy.has(open.id)} onClose={() => setOpen(null)}
          onReject={(i) => { setOpen(null); setRejecting(i); }} onDismiss={(i) => { setOpen(null); setConfirming(i); }} />
        <ConfirmDialog open={confirming !== null} title={confirming ? `Dismiss ${labelOf(confirming)}?` : 'Dismiss payment?'}
          message="It is set aside under Handled and nothing changes in your books or the payer's; you can restore it later."
          acceptLabel="Dismiss payment" loading={confirming !== null && busy.has(confirming.id)}
          onCancel={() => setConfirming(null)}
          onAccept={() => { const i = confirming; setConfirming(null); if (i) void act(i, 'dismiss', `Dismissed ${labelOf(i)}. You can restore it under Handled.`); }} />
        <InboxRejectModal path="allocations" item={rejecting ? { id: rejecting.id, number: labelOf(rejecting), senderName: rejecting.senderName } : null}
          onClose={() => setRejecting(null)} onDone={(msg) => { setRejecting(null); onNotice({ msg, ok: true }); void load(); }}
          onConflict={() => void load()} />
      </section>
    </>
  );
}
