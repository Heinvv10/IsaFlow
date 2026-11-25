/**
 * Accept a payment from the group (P4-D): clear it against this company's invoice with ONE contra settlement. Two steps: the preview (the
 * debit to this company's loan account, the credit to Accounts Receivable, the amount, the invoice, and a posting date the person picks,
 * proposed by the server), then a confirm that says what will post. The request sends back what the preview showed (loan account, invoice,
 * amount): the server refuses (409) if the books changed since. A refusal of the books comes back as the sentence stored on the message and
 * is shown here; nothing was posted.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { DateField } from '@/components/ui/DateField';
import { todayInSast } from '@/lib/saDateParser';
import { ApiRequestError, apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { AllocationClearingPreview } from '@/modules/accounting/services/intercompany/allocationClearTypes';

interface Props {
  /** The message to clear and its row's name ("payment SP-1 on INV-9"); null when closed. */
  target: { id: string; label: string } | null;
  preview: AllocationClearingPreview | null;
  onClose: () => void;
  /** Posted: the notice to show (the list reloads). */
  onDone: (message: string) => void;
  /** Not posted: the message is now `failed` with this sentence (the list reloads), or (`stale`) the server refused with a 409, so the preview
   *  is out of date and the person reviews it again from the detail. */
  onRefused: (message: string, stale: boolean) => void;
}

const btn = 'px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50';
const FAIL = 'Could not clear this payment - try again';

export function AllocationAcceptModal({ target, preview, onClose, onDone, onRefused }: Props) {
  const [date, setDate] = useState('');
  // the field refused what was typed (unreadable, before the payment, after today, a closed period): Review stays blocked
  const [dateRefused, setDateRefused] = useState(false);
  const [step, setStep] = useState<'review' | 'confirm'>('review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const errorLine = useRef<HTMLParagraphElement>(null);
  // where the focus goes after the next render: the date after Back, the sentence after a refusal (L4)
  const focusNext = useRef<'date' | 'error' | null>(null);
  const confirmId = `${useId()}-confirm`;
  // another message: its own proposed date, back to the first step, no old error
  useEffect(() => { setDate(preview?.defaultPostingDate ?? ''); setDateRefused(false); setStep('review'); setError(''); }, [target?.id, preview?.defaultPostingDate]);

  // (L4) the confirm step's control takes the focus the review step's button had (it is unmounted by the step change); Back returns it to the
  // date; a refusal puts it on the sentence that says why
  useEffect(() => {
    if (step === 'confirm') confirmButton.current?.focus();
    else if (focusNext.current === 'error' && error) errorLine.current?.focus();
    else if (focusNext.current === 'date') field.current?.focus();
    focusNext.current = null;
  }, [step, error]);
  // (M1) the floor: the later of the payment date and this company's invoice date
  const floor = preview?.paymentDate && preview.invoiceDate && preview.invoiceDate > preview.paymentDate ? preview.invoiceDate : preview?.paymentDate ?? null;
  const FLOOR_MESSAGE = "The posting date must be on or after the payment date and your invoice's date.";

  const ready = Boolean(target && preview?.loanAccountId && preview.invoiceId && preview.amount !== null);
  const missing = !preview?.loanAccountId ? 'Set your loan account on the connection first: there is nothing to clear against.'
    : !preview.receivableLabel ? 'Your chart has no Accounts Receivable control account.' : null;

  function review() {
    if (!date || dateRefused) { setError("Choose a posting date in an open period, on or after the payment date and your invoice's date."); return; }
    if (floor && date < floor) { setError(FLOOR_MESSAGE); return; }
    setError('');
    setStep('confirm');
  }

  async function post() {
    if (!target || !preview || !ready || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const out = await apiJson(`/api/accounting/intercompany/allocations/${target.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({ expectedLoanAccountId: preview.loanAccountId, invoiceId: preview.invoiceId, amount: preview.amount, postingDate: date }),
      }, FAIL);
      if (out.accepted) onDone(`Cleared ${target.label}: receipt ${out.paymentNumber} posted.`);
      else { focusNext.current = 'error'; setError(out.error); setStep('review'); onRefused(out.error, false); }
    } catch (err) {
      const message = apiErrorMessage(err, FAIL);
      focusNext.current = 'error';
      setError(message);
      setStep('review');
      if (err instanceof ApiRequestError && err.status === 409) onRefused(message, true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const amount = preview?.amount === null || preview?.amount === undefined ? '—' : formatCurrency(preview.amount);
  return (
    <Modal open={target !== null} onClose={busy ? () => undefined : onClose} title={target ? `Clear ${target.label}` : 'Clear payment'} size="md" initialFocusRef={field}>
      <Modal.Body>
        <div className="space-y-3 text-sm">
          <p className="text-ink-muted">
            This posts one journal in your books: the payment is cleared against your invoice through your intercompany loan account. No bank, no VAT; nothing changes in the payer&apos;s books.
          </p>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5" data-testid="allocation-accept-preview">
            <dt className="text-ink-muted">Debit</dt><dd className="text-ink">{preview?.loanAccountLabel ?? '—'}</dd>
            <dt className="text-ink-muted">Credit</dt><dd className="text-ink">{preview?.receivableLabel ?? 'Accounts Receivable'}</dd>
            <dt className="text-ink-muted">Amount</dt><dd className="text-ink tabular-nums">{amount}</dd>
            <dt className="text-ink-muted">Your invoice</dt><dd className="text-ink">{preview?.invoiceNumber ?? '—'}</dd>
            <dt className="text-ink-muted">Payment date</dt><dd className="text-ink">{formatDate(preview?.paymentDate ?? null)}</dd>
            <dt className="text-ink-muted">Invoice date</dt><dd className="text-ink">{formatDate(preview?.invoiceDate ?? null)}</dd>
          </dl>
          {step === 'review' ? (
            <div>
              <DateField id="ic-accept-date" ref={field} label="Posting date" value={date || null} postingDate keepsEscape
                minDate={floor ?? undefined} maxDate={todayInSast()} minMessage={FLOOR_MESSAGE}
                maxMessage="The posting date cannot be after today." disabled={busy || !ready}
                onChange={(iso, v) => { setDate(v.valid && iso ? iso : ''); setDateRefused(!v.valid); }} />
              {!preview?.defaultPostingDate && ready && <p className="mt-1 text-xs text-ink-muted">No open period on or after the payment date: choose a date in an open period.</p>}
            </div>
          ) : (
            <p id={confirmId} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-ink" data-testid="allocation-accept-confirm">
              Post {amount} on {formatDate(date)}: debit {preview?.loanAccountLabel}, credit {preview?.receivableLabel ?? 'Accounts Receivable'}, against invoice {preview?.invoiceNumber ?? ''}?
            </p>
          )}
          {missing && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{missing}</p>}
          {error && <p role="alert" ref={errorLine} tabIndex={-1} className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        {step === 'review' ? (
          <>
            <button type="button" onClick={onClose} disabled={busy} className={btn}>Cancel</button>
            <button type="button" onClick={review} disabled={busy || !ready || missing !== null}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">Review clearing</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => { focusNext.current = 'date'; setStep('review'); }} disabled={busy} className={btn}>Back</button>
            <button type="button" ref={confirmButton} aria-describedby={confirmId} onClick={() => void post()} disabled={busy}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Post clearing
            </button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
