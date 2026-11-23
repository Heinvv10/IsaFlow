/** One row of "Payments from your group" (P4-C): payer, payment, this company's invoice, amounts in their currency, state; its actions
 *  named by `label` (payment and invoice, unique on the page). */
import { StatusPill } from '@/components/ui';
import { formatDate } from '@/utils/formatters';
import type { AllocationItem } from '@/modules/accounting/services/intercompany/allocationInboxTypes';
import { allocationState, extraMismatch, HANDLED_LABEL, isOpen, moneyIn, STATE_CLASS } from './allocationLabels';

interface Props {
  item: AllocationItem;
  label: string;
  canWrite: boolean;
  busy: boolean;
  onDetails: () => void;
  onReject: () => void;
  onDismiss: () => void;
  onRestore: () => void;
}

const btn = 'px-2.5 py-1.5 text-xs font-medium rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50';
const chip = 'inline-block px-2 py-0.5 text-xs font-medium rounded-full border max-w-xs';

export function AllocationRow({ item: i, label, canWrite, busy, onDetails, onReject, onDismiss, onRestore }: Props) {
  const state = allocationState(i);
  const extra = extraMismatch(i);
  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/30 align-middle" data-testid="allocation-row">
      <td data-label="Payer" className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{i.senderName}</td>
      <td data-label="Payment" className="px-5 py-3.5">
        <span className="tabular-nums font-semibold text-amber-500">{i.paymentNumber ?? '—'}</span>
        <p className="text-xs text-ink-muted">{[i.paymentReference, formatDate(i.paymentDate)].filter(Boolean).join(' · ')}</p>
      </td>
      <td data-label="Your invoice" className="px-5 py-3.5 tabular-nums">{i.issuerInvoice?.number ?? '—'}</td>
      <td data-label="Amount" className="px-5 py-3.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white">{moneyIn(i.amount, i.currency)}</td>
      <td data-label="Open amount" className="px-5 py-3.5 text-right tabular-nums">{moneyIn(i.issuerInvoice?.openAmount, i.issuerInvoice?.currency)}</td>
      <td data-label="State" className="px-5 py-3.5 space-y-1">
        {isOpen(i)
          ? <span data-testid="allocation-state" className={`${chip} ${STATE_CLASS[state.tone]}`}>{state.text}</span>
          : <StatusPill status={i.status === 'withdrawn' ? 'cancelled' : i.status}>{HANDLED_LABEL[i.status]}</StatusPill>}
        {isOpen(i) && extra && <span data-testid="allocation-mismatch" className={`${chip} ${STATE_CLASS.check}`}>{extra}</span>}
        {i.status === 'rejected' && i.reason && <p className="text-xs text-ink-muted max-w-xs">Reason: {i.reason}</p>}
      </td>
      <td className="px-5 py-3.5 text-right">
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn} aria-label={`Details for ${label}`} onClick={onDetails}>Details</button>
          {isOpen(i) && canWrite && (
            <>
              <button type="button" className={btn} disabled={busy} aria-label={`Reject ${label}`} onClick={onReject}>Reject</button>
              <button type="button" className={btn} disabled={busy} aria-label={`Dismiss ${label}`} onClick={onDismiss}>Dismiss</button>
            </>
          )}
          {i.status === 'dismissed' && canWrite && (
            <button type="button" className={btn} disabled={busy} aria-label={`Restore ${label}`} onClick={onRestore}>Restore</button>
          )}
        </div>
      </td>
    </tr>
  );
}
