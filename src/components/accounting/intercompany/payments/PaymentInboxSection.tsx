/**
 * "Payments from your group" (intercompany F, cash mode): the payments a payer in the group applied to bills linked to this company's
 * invoices, each with its state word. Details open the drawer (facts, match suggestions, the two accept outcomes, discard of a draft).
 * Reject (a reason), Dismiss and Restore as for the other kinds. Nothing is offered to accept while the dark flag is off for this company.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ApiRequestError, apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { InboxFilter } from '@/modules/accounting/services/intercompany/inboxTypes';
import type { PaymentItem, PaymentPage } from '@/modules/accounting/services/intercompany/paymentInboxTypes';
import { InboxRejectModal } from '../InboxRejectModal';
import { PaymentDetailDrawer } from './PaymentDetailDrawer';
import { PaymentStateChip } from './PaymentStateChip';
import { HANDLED, rowLabel } from './paymentLabels';

interface Props { filter: InboxFilter; canWrite: boolean; onNotice: (n: { msg: string; ok: boolean }) => void }

const LOAD_ERROR = 'Could not load the payments from your group - try again';

export function PaymentInboxSection({ filter, canWrite, onNotice }: Props) {
  const [page, setPage] = useState<PaymentPage | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<PaymentItem | null>(null);
  const [rejecting, setRejecting] = useState<PaymentItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiJson(`/api/accounting/intercompany/payments?filter=${filter}&limit=100&offset=0`, undefined, LOAD_ERROR) as PaymentPage;
      if (mine !== latest.current) return;
      setPage(result);
      setError('');
      setOpen((cur) => (cur ? result.items.find((i) => i.id === cur.id) ?? null : null));
    } catch (err) {
      if (mine === latest.current) setError(apiErrorMessage(err, LOAD_ERROR));
    }
  }, [filter]);

  useEffect(() => { setPage(null); void load(); }, [load]);

  async function act(item: PaymentItem, what: 'dismiss' | 'restore') {
    setBusy(item.id);
    try {
      await apiJson(`/api/accounting/intercompany/payments/${item.id}/${what}`, { method: 'POST' }, `Could not ${what} this payment - try again`);
      setOpen(null);
      onNotice({ msg: what === 'dismiss' ? `Dismissed ${rowLabel(item)}. You can restore it under Handled.` : `Restored ${rowLabel(item)}.`, ok: true });
      await load();
    } catch (err) {
      onNotice({ msg: apiErrorMessage(err, `Could not ${what} this payment - try again`), ok: false });
      if (err instanceof ApiRequestError && err.status === 409) void load();
    } finally {
      setBusy(null);
    }
  }

  const items = page?.items ?? [];
  return (
    <section aria-labelledby="ic-payments-heading" className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
        <h2 id="ic-payments-heading" className="text-base font-semibold text-ink">Payments from your group</h2>
        <p className="text-sm text-ink-muted">
          {page?.enabled
            ? 'Payments a company in your group made to you from its bank, on bills linked to your invoices. Match one to a receipt you already have, or draft a receipt for it; nothing is posted until a receipt is confirmed.'
            : 'Payments a company in your group made to you from its bank, on bills linked to your invoices. You can reject or dismiss one.'}
        </p>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-2 m-4 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden /><span className="flex-1">{error}</span>
          <button type="button" onClick={() => void load()} className="underline">Try again</button>
        </div>
      )}
      {page && items.length === 0 && <p className="px-5 py-6 text-sm text-ink-muted">{filter === 'open' ? 'No payments waiting.' : 'No payments handled yet.'}</p>}
      {items.length > 0 && (
        <table className="table-cards w-full text-sm" data-testid="payment-table">
          <caption className="sr-only">Payments from your group: payer, payment, your invoice, amount and state</caption>
          <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
            <tr>{['Payer', 'Payment', 'Date', 'Your invoice', 'Amount', 'State', ''].map((h) => (
              <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-ink-muted uppercase tracking-wider">{h}</th>))}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((i) => (
              <tr key={i.id}>
                <td className="px-5 py-3">{i.senderName}</td>
                <td className="px-5 py-3">{i.paymentNumber ?? '—'}</td>
                <td className="px-5 py-3">{formatDate(i.paymentDate)}</td>
                <td className="px-5 py-3">{i.issuerInvoice?.number ?? '—'}</td>
                <td className="px-5 py-3">{i.amount === null ? '—' : formatCurrency(i.amount)}</td>
                <td className="px-5 py-3">{i.status === 'pending' ? <PaymentStateChip state={i.state} /> : <span>{HANDLED[i.status] ?? i.status}</span>}</td>
                <td className="px-5 py-3 text-right">
                  <button type="button" className="underline text-brand-600" aria-label={`Details for ${rowLabel(i)}`} onClick={() => setOpen(i)}>Details</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <PaymentDetailDrawer item={open} canWrite={canWrite} busy={open !== null && busy === open.id} onClose={() => setOpen(null)}
        onReject={(i) => { setOpen(null); setRejecting(i); }} onDismiss={(i) => void act(i, 'dismiss')} onRestore={(i) => void act(i, 'restore')}
        onChanged={(msg) => { setOpen(null); onNotice({ msg, ok: true }); void load(); }} />
      <InboxRejectModal path="payments" item={rejecting ? { id: rejecting.id, number: rowLabel(rejecting), senderName: rejecting.senderName } : null}
        onClose={() => setRejecting(null)} onDone={(msg) => { setRejecting(null); onNotice({ msg, ok: true }); void load(); }}
        onConflict={(msg) => { onNotice({ msg, ok: false }); void load(); }} />
    </section>
  );
}
