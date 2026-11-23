/**
 * Bills > Intercompany, "Payments from your group" (P4-C): the payments a payer in the group applied to bills linked to this company's
 * invoices, under the invoice list, shown only when there is one. Each row says whether the payer's books still say what it says (Live /
 * Stale: <reason>) and what does not fit this company's invoice (Check: <mismatch>). Read only: Reject (a reason is required), Dismiss (asked
 * first) and Restore of a dismissed one; there is NO Accept (clearing comes later, P4-D). Every action button names its payment.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { StatusPill } from '@/components/ui';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { InboxFilter } from '@/modules/accounting/services/intercompany/inboxTypes';
import type { AllocationItem, AllocationPage } from '@/modules/accounting/services/intercompany/allocationInboxTypes';
import { AllocationDetailDrawer } from './AllocationDetailDrawer';
import { InboxRejectModal } from './InboxRejectModal';
import { allocationState, HANDLED_LABEL, isOpen, paymentLabel, STATE_CLASS } from './allocationLabels';

interface Props {
  filter: InboxFilter;
  canWrite: boolean;
  onNotice: (n: { msg: string; ok: boolean }) => void;
  /** How many payments this list shows (0 while loading, on a failure, or when there are none): the invoice list words its empty state by it. */
  onCount?: (n: number) => void;
}

const LIMIT = 100;
const btn = 'px-2.5 py-1.5 text-xs font-medium rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50';
const COLUMNS = ['Payer', 'Payment', 'Your invoice', 'Amount', 'Open amount', 'State'];
const LOAD_ERROR = 'Could not load the payments from your group - try again';

export function AllocationInboxSection({ filter, canWrite, onNotice, onCount }: Props) {
  const [page, setPage] = useState<AllocationPage | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<AllocationItem | null>(null);
  const [rejecting, setRejecting] = useState<AllocationItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AllocationItem | null>(null);
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
      if (mine === latest.current) setError(apiErrorMessage(err, LOAD_ERROR));
    }
  }, [filter]);

  useEffect(() => { setPage(null); void load(); }, [load]);

  async function act(item: AllocationItem, what: 'dismiss' | 'restore', done: string) {
    setBusyId(item.id);
    try {
      await apiJson(`/api/accounting/intercompany/allocations/${item.id}/${what}`, { method: 'POST' }, `Could not ${what} this payment - try again`);
      setOpen(null);
      onNotice({ msg: done, ok: true });
      await load();
    } catch (err) {
      onNotice({ msg: apiErrorMessage(err, `Could not ${what} this payment - try again`), ok: false });
    } finally {
      setBusyId(null);
    }
  }

  const shownCount = error ? 0 : page?.items.length ?? 0;
  useEffect(() => { onCount?.(shownCount); }, [onCount, shownCount]);

  const items = page?.items ?? [];
  if (error) {
    return (
      <div role="alert" className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
        <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden /><span className="flex-1">Payments from your group: {error}</span>
        <button type="button" onClick={() => void load()} className="underline">Try again</button>
      </div>
    );
  }
  if (items.length === 0) return null;

  return (
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
            {COLUMNS.map((h, i) => (
              <th key={h} className={`px-5 py-3 text-xs font-semibold text-ink-muted uppercase tracking-wider ${i === 3 || i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
            <th className="px-5 py-3 text-right text-xs font-semibold text-ink-muted uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((i) => {
            const state = allocationState(i);
            const busy = busyId === i.id;
            return (
              <tr key={i.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 align-middle" data-testid="allocation-row">
                <td data-label="Payer" className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{i.senderName}</td>
                <td data-label="Payment" className="px-5 py-3.5">
                  <span className="tabular-nums font-semibold text-amber-500">{i.paymentNumber ?? '—'}</span>
                  <p className="text-xs text-ink-muted">{[i.paymentReference, formatDate(i.paymentDate)].filter(Boolean).join(' · ')}</p>
                </td>
                <td data-label="Your invoice" className="px-5 py-3.5 tabular-nums">{i.issuerInvoice?.number ?? '—'}</td>
                <td data-label="Amount" className="px-5 py-3.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white">
                  {i.amount === null ? '—' : formatCurrency(i.amount)}
                </td>
                <td data-label="Open amount" className="px-5 py-3.5 text-right tabular-nums">
                  {i.issuerInvoice?.openAmount == null ? '—' : formatCurrency(i.issuerInvoice.openAmount)}
                </td>
                <td data-label="State" className="px-5 py-3.5 space-y-1">
                  {isOpen(i)
                    ? <span data-testid="allocation-state" className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border max-w-xs ${STATE_CLASS[state.tone]}`}>{state.text}</span>
                    : <StatusPill status={i.status === 'withdrawn' ? 'cancelled' : i.status}>{HANDLED_LABEL[i.status]}</StatusPill>}
                  {i.status === 'rejected' && i.reason && <p className="text-xs text-ink-muted max-w-xs">Reason: {i.reason}</p>}
                </td>
                <td className="px-5 py-3.5 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className={btn} aria-label={`Details for payment ${paymentLabel(i)}`} onClick={() => setOpen(i)}>Details</button>
                    {isOpen(i) && canWrite && (
                      <>
                        <button type="button" className={btn} disabled={busy} aria-label={`Reject payment ${paymentLabel(i)}`} onClick={() => setRejecting(i)}>Reject</button>
                        <button type="button" className={btn} disabled={busy} aria-label={`Dismiss payment ${paymentLabel(i)}`} onClick={() => setConfirming(i)}>Dismiss</button>
                      </>
                    )}
                    {i.status === 'dismissed' && canWrite && (
                      <button type="button" className={btn} disabled={busy} aria-label={`Restore payment ${paymentLabel(i)}`}
                        onClick={() => void act(i, 'restore', `Restored payment ${paymentLabel(i)}.`)}>Restore</button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {page && page.total > items.length && (
        <p className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 text-sm text-ink-muted">Showing the latest {items.length} of {page.total}.</p>
      )}
      <AllocationDetailDrawer item={open} canWrite={canWrite} busy={busyId !== null && busyId === open?.id} onClose={() => setOpen(null)}
        onReject={(i) => { setOpen(null); setRejecting(i); }} onDismiss={(i) => { setOpen(null); setConfirming(i); }} />
      <ConfirmDialog open={confirming !== null} title={confirming ? `Dismiss payment ${paymentLabel(confirming)}?` : 'Dismiss payment?'}
        message="It is set aside under Handled and nothing changes in your books or the payer's; you can restore it later."
        acceptLabel="Dismiss payment" loading={confirming !== null && busyId === confirming.id}
        onCancel={() => setConfirming(null)}
        onAccept={() => { const i = confirming; setConfirming(null); if (i) void act(i, 'dismiss', `Dismissed payment ${paymentLabel(i)}. You can restore it under Handled.`); }} />
      <InboxRejectModal path="allocations" item={rejecting ? { id: rejecting.id, number: paymentLabel(rejecting), senderName: rejecting.senderName } : null}
        onClose={() => setRejecting(null)} onDone={(msg) => { setRejecting(null); onNotice({ msg, ok: true }); void load(); }} />
    </section>
  );
}
