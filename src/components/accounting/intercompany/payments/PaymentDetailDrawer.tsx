/**
 * One payment from the group (intercompany F, cash mode): the payload's facts, the state word, and while it is open and the flag is on, the
 * MATCH SUGGESTIONS over this company's own rows: the linked invoice (and the customer's other open invoices), the receipts it can be matched
 * to ("This is my receipt", outcome `existing`), "Draft a receipt" (outcome `draft`, refused while a receipt already matches it), and the
 * unmatched bank lines as a hint only (no action). An accepted message whose target is its F draft offers "Discard draft". Reject / Dismiss
 * / Restore as for the other kinds.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { PaymentDetail, PaymentItem, ReceiptSuggestion } from '@/modules/accounting/services/intercompany/paymentInboxTypes';
import { PaymentStateChip } from './PaymentStateChip';
import { PaymentDraftForm } from './PaymentDraftForm';
import { PaymentDiscardModal } from './PaymentDiscardModal';
import { HANDLED, rowLabel } from './paymentLabels';

interface Props {
  item: PaymentItem | null;
  canWrite: boolean;
  busy: boolean;
  onClose: () => void;
  onReject: (item: PaymentItem) => void;
  onDismiss: (item: PaymentItem) => void;
  onRestore: (item: PaymentItem) => void;
  /** An accept or a discard finished: the list reloads, the notice says what happened. */
  onChanged: (msg: string) => void;
}

const btn = 'px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50 inline-flex items-center gap-2';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-1.5 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-ink-muted">{label}</dt><dd className="text-ink break-words">{children}</dd>
    </div>
  );
}

export function PaymentDetailDrawer({ item, canWrite, busy, onClose, onReject, onDismiss, onRestore, onChanged }: Props) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [error, setError] = useState('');
  const [matching, setMatching] = useState<ReceiptSuggestion | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [working, setWorking] = useState(false);
  const id = item?.id ?? null;

  useEffect(() => {
    setDetail(null); setError(''); setDrafting(false); setMatching(null);
    if (!id) return undefined;
    let current = true;
    apiJson(`/api/accounting/intercompany/payments/${id}`, undefined, 'Could not load this payment - try again')
      .then((d) => { if (current) setDetail(d as PaymentDetail); })
      .catch((err: unknown) => { if (current) setError(apiErrorMessage(err, 'Could not load this payment - try again')); });
    return () => { current = false; };
  }, [id]);

  if (!item) return null;
  const shown = detail?.item ?? item;
  const label = rowLabel(shown);
  const s = detail?.enabled && shown.status === 'pending' ? detail.suggestions : null;
  const open = shown.status === 'pending';

  async function match(r: ReceiptSuggestion) {
    setWorking(true);
    try {
      await apiJson(`/api/accounting/intercompany/payments/${shown.id}/accept`, {
        method: 'POST', body: JSON.stringify({ outcome: 'existing', receiptId: r.id, expected: { amount: shown.amount, state: shown.state } }),
      }, 'Could not match this payment - try again');
      onChanged(`Matched ${label} to receipt ${r.number}. Nothing was posted.`);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not match this payment - try again'));
    } finally {
      setWorking(false); setMatching(null);
    }
  }

  return (
    <Drawer open onClose={onClose} title={`Details for ${label}`} width="lg">
      <div className="p-5 space-y-4">
        <div>{open ? <PaymentStateChip state={shown.state} /> : <span className="text-sm font-medium text-ink">{HANDLED[shown.status] ?? shown.status}</span>}
          {!open && shown.state !== 'open' && <span className="ml-2"><PaymentStateChip state={shown.state} /></span>}
          {shown.reason && <p className="mt-1 text-xs text-ink-muted">Reason: {shown.reason}</p>}</div>
        <dl className="divide-y divide-slate-100 dark:divide-slate-800">
          <Fact label="Payer">{shown.senderName}</Fact>
          <Fact label="Payment">{shown.paymentNumber ?? '—'}</Fact>
          <Fact label="Reference">{shown.paymentReference ?? '—'}</Fact>
          <Fact label="Date">{formatDate(shown.paymentDate)}</Fact>
          <Fact label="Amount">{shown.amount === null ? '—' : formatCurrency(shown.amount)}</Fact>
          <Fact label="Payer's bill">{shown.payerDocumentNumber ?? '—'}{shown.payerDocumentDate ? ` (${formatDate(shown.payerDocumentDate)})` : ''}</Fact>
          <Fact label="Matched to">{shown.target ? `Receipt ${shown.target.paymentNumber} (${shown.target.status})` : '—'}</Fact>
        </dl>
        {!detail && !error && <p className="text-xs text-ink-muted inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Loading</p>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {s && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-ink">Your open invoices</h3>
            <ul aria-label="Your open invoices" className="text-sm space-y-1">
              {s.invoices.map((i) => <li key={i.id}>{i.number}{i.linked ? ' (linked)' : ''} - open {formatCurrency(i.openAmount)}</li>)}
            </ul>
            <h3 className="text-sm font-semibold text-ink">Receipts it may be</h3>
            {s.receipts.length === 0 ? <p className="text-sm text-ink-muted">No receipt of yours matches this payment.</p> : (
              <ul aria-label="Receipts it may be" className="text-sm space-y-1">
                {s.receipts.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span>{r.number} - {formatDate(r.date)} - {formatCurrency(r.unconsumed)} left{r.exact ? ' (exact)' : ''}</span>
                    {canWrite && <button type="button" className={btn} disabled={working} onClick={() => setMatching(r)}>This is my receipt {r.number}</button>}
                  </li>
                ))}
              </ul>
            )}
            {s.draftAllowed
              ? canWrite && !drafting && <button type="button" className={btn} onClick={() => setDrafting(true)}>Draft a receipt for {label}</button>
              : <p className="text-sm text-ink-muted">A receipt you already have matches this payment: use the receipt above instead of drafting another one.</p>}
            {drafting && <PaymentDraftForm item={shown} suggestions={s} onCancel={() => setDrafting(false)} onDone={(msg) => { setDrafting(false); onChanged(msg); }} />}
            <h3 className="text-sm font-semibold text-ink">Bank lines (hint only)</h3>
            <ul aria-label="Bank lines (hint only)" className="text-sm space-y-1 text-ink-muted">
              {s.bankLines.length === 0 ? <li>No unmatched incoming bank line looks like it.</li>
                : s.bankLines.map((b) => <li key={b.id}>{formatDate(b.date)} - {formatCurrency(b.amount)} - {b.description}</li>)}
            </ul>
          </div>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {open && <button type="button" className={btn} disabled={busy} aria-label={`Reject ${label}`} onClick={() => onReject(shown)}>Reject</button>}
            {open && <button type="button" className={btn} disabled={busy} aria-label={`Dismiss ${label}`} onClick={() => onDismiss(shown)}>Dismiss</button>}
            {shown.status === 'dismissed' && <button type="button" className={btn} disabled={busy} onClick={() => onRestore(shown)}>Restore</button>}
            {shown.status === 'accepted' && shown.target?.isDraft && (
              <button type="button" className={btn} onClick={() => setDiscarding(true)}>Discard draft {shown.target.paymentNumber}</button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog open={matching !== null} title={matching ? `Match ${label} to receipt ${matching.number}?` : 'Match?'}
        message="The payment message is marked as this receipt. Nothing is posted and the receipt is not changed." acceptLabel="Confirm match"
        loading={working} onCancel={() => setMatching(null)} onAccept={() => { if (matching) void match(matching); }} />
      <PaymentDiscardModal open={discarding} messageId={shown.id} target={shown.target} onClose={() => setDiscarding(false)}
        onDone={(msg) => { setDiscarding(false); onChanged(msg); }} />
    </Drawer>
  );
}
