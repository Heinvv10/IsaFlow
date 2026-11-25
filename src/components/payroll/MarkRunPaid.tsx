/**
 * "Mark paid" for an approved pay run (wave 7 MP, W27; Hein rulings 4 and 16), and the note a paid run shows.
 *
 * MarkRunPaidButton (the run's title bar): owner, admin or manager, an approved run with its journal. A dialog asks how
 * the run was paid: by its confirmed salary bank file (POST {}), or another way, with the bank payment reference and the
 * payment date (POST { reference, paidOn }). The server judges everything (payrollRunMarkPaid); its refusal is shown.
 * RunPaidNote: who recorded the payment, when, and its date and reference. A paid run cannot be reopened.
 */
import { useRef, useState } from 'react';
import { BadgeCheck, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { DateField } from '@/components/ui/DateField';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate, formatDisplayDateTime } from '@/utils/dateFormat';
import { announcePayrollRunChanged } from '@/components/payroll/payrollRunEvents';

const BTN = 'px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium disabled:opacity-50';
const FAILED = 'Could not mark the run paid - try again';
const MARKERS = new Set(['owner', 'admin', 'manager']);

export interface PaidRun {
  status: string;
  journalEntryId: string | null;
  paidAt?: string | null;
  paidOn?: string | null;
  paidReference?: string | null;
  paidByName?: string | null;
}

export function canMarkPaid(run: PaidRun, companyRole: string | null | undefined): boolean {
  return run.status === 'approved' && !!run.journalEntryId && MARKERS.has(companyRole ?? '');
}

export function MarkRunPaidButton({ runId, run, companyRole, onPaid }: {
  runId: string; run: PaidRun; companyRole: string | null | undefined; onPaid: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [byFile, setByFile] = useState(false);
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState<string | null>(todayInSast());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  if (!canMarkPaid(run, companyRole)) return null;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setError('');
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const typedReady = reference.trim().length > 0 && !!paidOn;
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const body = byFile ? {} : { reference: reference.trim(), paidOn };
      const res = await apiFetch(`/api/payroll/runs/${runId}/mark-paid`, { method: 'POST', body: JSON.stringify(body) });
      await assertOk(res, FAILED);
      setOpen(false);
      announcePayrollRunChanged(); // the period bar re-reads the run's status
      onPaid();
    } catch (err) {
      setError(apiErrorMessage(err, FAILED));
    } finally {
      setBusy(false);
    }
  };
  const choice = (file: boolean, label: string) => (
    <button type="button" role="radio" aria-checked={byFile === file} onClick={() => setByFile(file)}
      className={`${BTN} border text-left ${byFile === file
        ? 'border-teal-600 bg-teal-500/10 text-[var(--ff-text-primary)]'
        : 'border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]'}`}>
      {label}
    </button>
  );

  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}
        className={`${BTN} flex items-center gap-2 bg-success-700 hover:bg-success-800 text-white`}
        title="Record that the bank has paid this run's net pay">
        <BadgeCheck className="h-4 w-4" aria-hidden="true" /> Mark paid
      </button>
      <Modal open={open} onClose={close} title="Mark this pay run paid?" size="sm">
        <Modal.Body className="space-y-3 text-sm text-[var(--ff-text-secondary)]">
          <p>Once paid, the run cannot be reopened: a correction is made with an off-cycle run.</p>
          <div role="radiogroup" aria-label="How was it paid?" className="flex flex-col gap-2">
            {choice(false, 'Paid another way: I have the bank payment reference')}
            {choice(true, 'Paid by its salary bank file, which the bank accepted')}
          </div>
          {!byFile && (
            <div className="space-y-3">
              <Input label="Bank payment reference" value={reference} maxLength={64} required
                onChange={(e) => setReference(e.target.value)} />
              <DateField label="Payment date" value={paidOn} maxDate={todayInSast()} required
                onChange={(iso) => setPaidOn(iso)} />
            </div>
          )}
          {error && <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>}
        </Modal.Body>
        <Modal.Footer>
          <button type="button" onClick={close} disabled={busy}
            className={`${BTN} border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)]`}>Not yet</button>
          <button type="button" onClick={() => void submit()} disabled={busy || (!byFile && !typedReady)}
            className={`${BTN} flex items-center gap-2 bg-success-700 hover:bg-success-800 text-white`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <BadgeCheck className="h-4 w-4" aria-hidden="true" />} Mark paid
          </button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

export function RunPaidNote({ run }: { run: PaidRun }) {
  if (run.status !== 'paid') return null;
  // B7/Q2 (review #1911): a legacy paid row (before migration 1053, e.g. the Demo reseed's) has neither a reference nor a
  // payment date, and no file behind it: it is not described as paid by a bank file.
  if (!run.paidReference && !run.paidOn) {
    return (
      <div role="status" className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-sm">
        Paid (recorded before payment records were kept). A paid run cannot be reopened.
      </div>
    );
  }
  const how = run.paidReference ? `bank reference ${run.paidReference}` : 'its confirmed salary bank file';
  const who = run.paidByName ? ` by ${run.paidByName}` : '';
  const when = run.paidAt ? ` on ${formatDisplayDateTime(run.paidAt)}` : '';
  return (
    <div role="status" className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-sm">
      Paid{run.paidOn ? ` on ${formatDisplayDate(run.paidOn)}` : ''} ({how}). Recorded{who}{when}. A paid run cannot be reopened.
    </div>
  );
}
