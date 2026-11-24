/**
 * "Clear against the intercompany loan" (P4-E): two steps. The preview (debit Accounts Payable, credit this company's loan account, the amount,
 * proposed as what is open and editable down to a partial clearing, the partner, whether the partner can clear it, and a posting date proposed
 * as today), then a confirm that says what will post. The request sends back what the preview showed (loan account, link, amount, the bill's
 * open amount, the AP control): the server refuses (409) if the books changed since. A refusal shows its sentence; nothing was posted. After a
 * 409 (the books changed, or the bill is busy) the panel fetches the preview again (`onStale`), so a retry sends what the books now say; the
 * sentence stays until the person acts. "Partner ready" means the partner can clear SOMETHING now (fix round 2 MED-3: the preview asks for one
 * cent); the amount chosen is judged when it posts. The amount is a MoneyField (integer cents, parsed on blur / Enter). Focus (fix round 2):
 * after Review it moves to Post clearing; a refusal moves it to the sentence, every time, the same sentence again too (round 3: keyed on a
 * count, not on the text); Back returns it to the amount.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { MoneyField } from '@/components/ui/MoneyField';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { DateField } from '@/components/ui/DateField';
import { todayInSast } from '@/lib/saDateParser';
import { ApiRequestError, apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { LoanClearingPreview, LoanClearResult } from '@/modules/accounting/services/intercompany/payerLoanClearTypes';

interface Props {
  open: boolean;
  preview: LoanClearingPreview;
  onClose: () => void;
  onDone: (out: LoanClearResult) => void;
  /** A 409 (stale preview, bill busy): fetch the preview again. */
  onStale: () => void;
}

const TITLE = 'Clear against the intercompany loan';
const FAIL = 'Could not clear this bill - try again';
const btn = 'px-3 py-2 text-sm rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50';
const toCents = (n: number) => Math.round(n * 100);
/** Long account and partner names wrap inside the grid at 360 px (fix round 2). */
const cell = 'text-ink min-w-0 break-words';

export function LoanClearingModal({ open, preview, onClose, onDone, onStale }: Props) {
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [amountRefused, setAmountRefused] = useState<string | null>(null);
  const [amountReset, setAmountReset] = useState(0);
  const [date, setDate] = useState('');
  const [dateRefused, setDateRefused] = useState(false);
  const [step, setStep] = useState<'review' | 'confirm'>('review');
  const [busy, setBusy] = useState(false);
  const [error, setErrorText] = useState('');
  const [errorSeq, setErrorSeq] = useState(0);
  const [backSeq, setBackSeq] = useState(0);
  /** Every refusal counts, the same text again too: the focus follows each one (round 3). */
  const setError = (text: string) => { setErrorText(text); if (text) setErrorSeq((n) => n + 1); };
  const submitting = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const postRef = useRef<HTMLButtonElement>(null);
  const confirmId = `${useId()}-confirm`;
  const amountId = `${useId()}-amount`;
  const maxCents = preview.maxAmount === null ? null : toCents(preview.maxAmount);
  // opening the dialog starts it afresh; a preview fetched again while it is open (after a 409) only moves the proposed amount
  useEffect(() => {
    if (!open) return;
    setDate(preview.defaultPostingDate); setDateRefused(false); setStep('review'); setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on opening only: a refetched preview must not wipe the date or the sentence
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setAmountCents(maxCents); setAmountRefused(null); setAmountReset((k) => k + 1);
  }, [open, maxCents]);
  // a refusal (the dialog's own or the server's) takes the focus to its sentence; Review takes it to Post clearing
  // keyed on the count, not the text: the same sentence set again must move the focus again
  useEffect(() => { if (errorSeq > 0) alertRef.current?.focus(); }, [errorSeq]);
  useEffect(() => { if (step === 'confirm') postRef.current?.focus(); }, [step]);
  useEffect(() => { if (backSeq > 0) amountRef.current?.focus(); }, [backSeq]);

  const amount = amountCents === null ? NaN : amountCents / 100;
  const ready = preview.linked && preview.blocked === null && preview.loanAccountId !== null && preview.linkId !== null && preview.openAmount !== null
    && preview.payableAccountId !== null;

  function review() {
    const max = preview.maxAmount ?? 0;
    if (amountRefused) { setError(amountRefused); return; }
    if (amountCents === null || amountCents <= 0) { setError('Enter an amount in rand and cents, more than zero.'); return; }
    if (toCents(amount) > toCents(max)) { setError(`The amount is more than what is still open on this bill (${formatCurrency(max)}).`); return; }
    if (!date || dateRefused) { setError("Choose a posting date in an open period, on or after the bill's date, not after today."); return; }
    setError('');
    setStep('confirm');
  }

  async function post() {
    if (!ready || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const out = (await apiJson('/api/accounting/intercompany/loan-clearings', {
        method: 'POST',
        body: JSON.stringify({
          billId: preview.billId, amount, postingDate: date,
          expected: {
            loanAccountId: preview.loanAccountId, linkId: preview.linkId, amount, openAmount: preview.openAmount, payableAccountId: preview.payableAccountId,
          },
        }),
      }, FAIL)) as LoanClearResult;
      onDone(out);
    } catch (err) {
      setError(apiErrorMessage(err, FAIL));
      setStep('review');
      if (err instanceof ApiRequestError && err.status === 409) onStale();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const shown = Number.isFinite(amount) && amount > 0 ? formatCurrency(amount) : '—';
  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title={TITLE} size="md" initialFocusRef={field}>
      <Modal.Body>
        <div className="space-y-3 text-sm">
          <p className="text-ink-muted">
            This posts one journal in your books: the bill is settled against your intercompany loan account, with no bank and no VAT. The partner is then sent the payment, to clear its invoice against its own loan account.
          </p>
          <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-2 gap-y-1.5" data-testid="loan-clearing-preview">
            <dt className="text-ink-muted">Debit</dt><dd className={cell}>{preview.payableLabel ?? 'Accounts Payable'}</dd>
            <dt className="text-ink-muted">Credit</dt><dd className={cell}>{preview.loanAccountLabel ?? '—'}</dd>
            <dt className="text-ink-muted">Open on the bill</dt><dd className={`${cell} tabular-nums`}>{preview.openAmount === null ? '—' : formatCurrency(preview.openAmount)}</dd>
            <dt className="text-ink-muted">Partner</dt><dd className={cell}>{preview.partnerName ?? '—'}</dd>
            <dt className="text-ink-muted">Partner ready</dt>
            <dd className={cell}>{preview.receiverReady ? 'Can clear against its loan account (the amount is checked when you post)' : 'Not ready to clear it'}</dd>
          </dl>
          {preview.blocked && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400 break-words">{preview.blocked}</p>}
          {step === 'review' ? (
            <div className="space-y-2">
              <MoneyField id={amountId} ref={amountRef} label="Amount" value={amountCents} resetKey={amountReset} disabled={busy || !ready} className="w-48"
                onChange={(cents, v) => { setAmountCents(cents); setAmountRefused(v.valid ? null : v.reason ?? 'Enter an amount in rand and cents.'); }} />
              <DateField id="ic-loan-clear-date" ref={field} label="Posting date" value={date || null} postingDate keepsEscape
                minDate={preview.floorDate ?? undefined} maxDate={todayInSast()} minMessage="The posting date must be on or after the bill's date and the pair's cut-over."
                maxMessage="The posting date cannot be after today." disabled={busy || !ready}
                onChange={(iso, v) => { setDate(v.valid && iso ? iso : ''); setDateRefused(!v.valid); }} />
            </div>
          ) : (
            <p id={confirmId} className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-ink break-words" data-testid="loan-clearing-confirm">
              Post {shown} on {formatDate(date)}: debit {preview.payableLabel ?? 'Accounts Payable'}, credit {preview.loanAccountLabel}, against bill {preview.billNumber ?? ''}?
            </p>
          )}
          {error && <p ref={alertRef} role="alert" tabIndex={-1} className="text-sm text-red-600 dark:text-red-400 break-words">{error}</p>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        {step === 'review' ? (
          <>
            <button type="button" onClick={onClose} disabled={busy} className={btn}>Cancel</button>
            <button type="button" onClick={review} disabled={busy || !ready}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50">Review clearing</button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => { setStep('review'); setBackSeq((n) => n + 1); }} disabled={busy} className={btn}>Back</button>
            <button ref={postRef} type="button" aria-describedby={confirmId} onClick={() => void post()} disabled={busy}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-2">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Post clearing
            </button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
