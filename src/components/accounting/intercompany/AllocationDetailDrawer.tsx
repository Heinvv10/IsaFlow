/** One payment from the group (P4-C): the payload's facts, this company's invoice it names, its state; Reject and Dismiss. P4-D: Accept (it clears
 *  the payment against the invoice, with the preview this detail carries), and an accepted one's clearing receipt, flagged when it was voided.
 *  Accept (and the sentence about it) only while the dark flag intercompany_loan_clearing is on: the list's answer AND this detail's. */
import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatDate } from '@/utils/formatters';
import type { AllocationDetail, AllocationItem } from '@/modules/accounting/services/intercompany/allocationInboxTypes';
import type { AllocationClearingPreview } from '@/modules/accounting/services/intercompany/allocationClearTypes';
import { allocationState, HANDLED_LABEL, isOpen, LINK_ORIGIN, moneyIn, paymentLabel, STATE_CLASS, VOIDED_CHIP } from './allocationLabels';

interface Props {
  item: AllocationItem | null;
  /** The row's name (payment and invoice), as its buttons in the list say it. */
  label: string;
  canWrite: boolean;
  /** The list's `loanClearingEnabled`: false, no Accept (the detail's own answer can only turn it off). */
  clearingEnabled: boolean;
  busy: boolean;
  onClose: () => void;
  onReject: (item: AllocationItem) => void;
  onDismiss: (item: AllocationItem) => void;
  /** P4-D: open the Accept preview for this message, with what the detail says would post. */
  onAccept: (item: AllocationItem, preview: AllocationClearingPreview) => void;
}

const btn = 'px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50 inline-flex items-center gap-2';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-1.5 text-sm sm:grid-cols-[10rem_1fr] sm:gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-ink break-words">{children}</dd>
    </div>
  );
}

export function AllocationDetailDrawer({ item, label, canWrite, clearingEnabled, busy, onClose, onReject, onDismiss, onAccept }: Props) {
  const [detail, setDetail] = useState<AllocationDetail | null>(null);
  const [error, setError] = useState('');
  const id = item?.id ?? null;

  useEffect(() => {
    setDetail(null);
    setError('');
    if (!id) return undefined;
    let current = true;
    apiJson(`/api/accounting/intercompany/allocations/${id}`, undefined, 'Could not load this payment - try again')
      .then((d) => { if (current) setDetail(d); })
      .catch((err: unknown) => { if (current) setError(apiErrorMessage(err, 'Could not load this payment - try again')); });
    return () => { current = false; };
  }, [id]);

  if (!item) return null;
  const shown = detail?.item ?? item;
  const state = allocationState(shown);
  const inv = shown.issuerInvoice;
  const mayClear = clearingEnabled && detail?.loanClearingEnabled !== false;
  return (
    <Drawer open onClose={onClose} title={label ? `Details for ${label}` : `Payment ${paymentLabel(shown)}`} width="lg">
      <div className="p-5 space-y-4">
        <div>
          {isOpen(shown)
            ? <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${STATE_CLASS[state.tone]}`}>{state.text}</span>
            : <span className="text-sm font-medium text-ink">{HANDLED_LABEL[shown.status]}</span>}
          {shown.reason && <p className="mt-1 text-xs text-ink-muted">Reason: {shown.reason}</p>}
          {shown.status === 'failed' && shown.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400" data-testid="allocation-failed-error">Not cleared: {shown.error}</p>}
        </div>
        <dl className="divide-y divide-slate-100 dark:divide-slate-800">
          <Fact label="Payer">{shown.senderName}</Fact>
          <Fact label="Payment">{shown.paymentNumber ?? '—'}</Fact>
          <Fact label="Reference">{shown.paymentReference ?? '—'}</Fact>
          <Fact label="Date">{formatDate(shown.paymentDate)}</Fact>
          <Fact label="Method">{shown.paymentMethod ?? '—'}</Fact>
          <Fact label="Amount">{moneyIn(shown.amount, shown.currency)}</Fact>
          <Fact label="Paid">
            {shown.cashLegIsLoanAccount === null ? '—' : shown.cashLegIsLoanAccount ? 'Paid through the intercompany loan account' : 'Paid from a bank account'}
          </Fact>
          <Fact label="Payer's bill">{shown.payerDocumentNumber ?? '—'}</Fact>
          <Fact label="Your invoice">{inv ? `${inv.number} (${inv.status})` : 'Not found in your books'}</Fact>
          <Fact label="Open on your invoice">
            {!inv ? '—' : inv.openAmount === null ? 'Not open' : moneyIn(inv.openAmount, inv.currency)}
          </Fact>
          <Fact label="Linked by">{detail?.linkOrigin ? LINK_ORIGIN[detail.linkOrigin] ?? detail.linkOrigin : '—'}</Fact>
          <Fact label="Cut-over">{detail?.cutoverDate ? formatDate(detail.cutoverDate) : '—'}</Fact>
        </dl>
        {!detail && !error && <p className="text-xs text-ink-muted inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Loading</p>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {shown.clearedBy && (
          <div className="text-sm text-ink" data-testid="allocation-cleared-by">
            Cleared by receipt {shown.clearedBy.paymentNumber ?? '—'}
            {shown.clearedBy.voided && <span className={`ml-2 inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${STATE_CLASS.check}`}>{VOIDED_CHIP}</span>}
            {shown.clearedBy.voided && <p className="mt-1 text-xs text-ink-muted">The clearing receipt was voided after it was accepted: the invoice is open again. To clear it again, the payer must unapply the payment and apply it again (that sends a new message); the same allocation is never sent twice.</p>}
          </div>
        )}
        {isOpen(shown) && (
          <p className="text-sm text-ink-muted">
            {mayClear
              ? 'Accept clears this payment against your invoice through your intercompany loan account (one journal; you choose the date). Or reject it with a reason, or dismiss it.'
              : 'You can reject it with a reason, or dismiss it.'}
          </p>
        )}
        {isOpen(shown) && canWrite && (
          <div className="flex gap-2">
            {mayClear && (
              <button type="button" className={btn} disabled={busy || !detail?.preview} aria-label={`Accept ${label}`}
                onClick={() => { if (detail?.preview) onAccept(shown, detail.preview); }}>Accept</button>
            )}
            <button type="button" className={btn} disabled={busy} aria-label={`Reject ${label}`} onClick={() => onReject(shown)}>Reject</button>
            <button type="button" className={btn} disabled={busy} aria-label={`Dismiss ${label}`} onClick={() => onDismiss(shown)}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Dismiss
            </button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
