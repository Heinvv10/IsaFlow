/**
 * SalaryBankFileCard — the salary bank file of an approved pay run (wave 6 BF). Generate the ACB file for an action
 * date (downloaded from memory; owner / admin), then record that the bank accepted it (confirm) or void it. A confirmed
 * file shows the run as payment-confirmed; the run stays approved and can still be reopened, with a warning.
 * Shown for approved and paid runs; re-read whenever the run's status changes (a reopen makes a file stale).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Banknote, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { todayInSast } from '@/lib/saDateParser';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';
import { DateField } from '@/components/ui/DateField';
import { Modal } from '@/components/ui/Modal';
import type { PayrollBankFile, RunBankFileState } from '@/modules/accounting/services/payroll/payrollBankFileStatus';

const LOAD_FAILED = 'Could not load the salary bank file - try again';
const BTN = 'px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50';

const people = (n: number) => `${n} ${n === 1 ? 'employee' : 'employees'}`;

/**
 * D-3/E-5: what a confirmed file of an earlier approval leaves to settle, per employee and never netted. Owed and
 * overpaid are separate sentences, each naming the people; an empty list means the file is for the current approval.
 */
export function settlementLines(f: PayrollBankFile): string[] {
  const s = f.settlement;
  if (!s) return [];
  const names = (list: { employeeNumber: string; name: string; cents: number }[]) =>
    list.map((e) => `${e.name} (${e.employeeNumber}) ${formatCurrency(e.cents / 100)}`).join(', ');
  const lines: string[] = [];
  if (s.owedCents > 0) lines.push(`Still to pay ${formatCurrency(s.owedCents / 100)} to ${people(s.owedTo.length)} separately: ${names(s.owedTo)}.`);
  if (s.overpaidCents > 0) lines.push(`Overpaid ${formatCurrency(s.overpaidCents / 100)} by ${people(s.overpaidBy.length)}: ${names(s.overpaidBy)}.`);
  if (lines.length === 0) lines.push('Nothing more to pay: every employee was paid their current net.');
  return lines;
}

function statusLabel(f: PayrollBankFile): string {
  if (f.status === 'confirmed') return f.settlement ? 'Paid by the bank on an earlier approval' : 'Payment confirmed';
  if (f.status === 'voided') return 'Voided';
  return f.stale ? 'Made before the run was reopened: record it if the bank paid it, or void it' : 'Generated, not yet confirmed';
}

function download(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SalaryBankFileCard({ runId, runStatus, canManage }: { runId: string; runStatus: string; canManage: boolean }) {
  const [state, setState] = useState<RunBankFileState | null>(null);
  const [error, setError] = useState('');
  const [actionDate, setActionDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, setPending] = useState<{ file: PayrollBankFile; action: 'confirm' | 'void' } | null>(null);
  const [notSent, setNotSent] = useState(false);
  const [notice, setNotice] = useState('');
  const firstButton = useRef<HTMLButtonElement>(null);
  const ask = (file: PayrollBankFile, action: 'confirm' | 'void') => { setNotSent(false); setPending({ file, action }); };

  const load = useCallback(async () => {
    try {
      const read = await apiJson(`/api/payroll/runs/${runId}/bank-file`, undefined, LOAD_FAILED);
      if (!('files' in read)) throw new Error(LOAD_FAILED);
      setState(read);
    } catch (err) {
      setError(apiErrorMessage(err, LOAD_FAILED));
    }
  }, [runId]);
  useEffect(() => { void load(); }, [load, runStatus]);

  const generate = async () => {
    if (!actionDate) return;
    setBusy(true); setError(''); setWarnings([]); setNotice('');
    try {
      const made = await apiJson(`/api/payroll/runs/${runId}/bank-file`,
        { method: 'POST', body: JSON.stringify({ actionDate }) }, 'Could not generate the bank file - try again');
      if (!('content' in made)) throw new Error('Could not generate the bank file - try again');
      download(made.filename, made.content);
      setWarnings(made.warnings);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not generate the bank file - try again'));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const settle = async () => {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/bank-file/${pending.file.id}/${pending.action}`,
        { method: 'POST', body: JSON.stringify(pending.action === 'void' ? { notSentToBank: notSent } : {}) });
      await assertOk(res, `Could not ${pending.action} the bank file - try again`);
      setWarnings([]);
      setNotice(pending.action === 'void'
        ? 'File voided. That file is now dead: never upload it to the bank. Generate a new one if the run still needs paying.'
        : '');
    } catch (err) {
      setError(apiErrorMessage(err, `Could not ${pending.action} the bank file - try again`));
    } finally {
      setPending(null); setBusy(false);
      void load();
    }
  };

  const live = state?.files.find((f) => f.status === 'generated');
  const confirmed = state?.files.find((f) => f.status === 'confirmed');
  const final = ['approved', 'paid'].includes(runStatus);
  const canGenerate = canManage && !!state?.enabled && !live && !confirmed && final;
  if (!final && state?.files.length === 0) return null;

  return (
    <section aria-labelledby="bank-file-heading" className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Banknote className="h-5 w-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        <h2 id="bank-file-heading" className="text-sm font-semibold text-[var(--ff-text-primary)]">Salary bank file</h2>
      </div>
      {state === null && !error && (
        <p className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</p>
      )}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {confirmed && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {!confirmed.settlement
            ? <>The bank has paid this run (file confirmed {confirmed.confirmedAt ? formatDisplayDate(confirmed.confirmedAt.slice(0, 10)) : ''}).
              Reopening the run does not reverse that payment: pay any difference separately.</>
            : <span>The bank paid {formatCurrency(confirmed.totalCents / 100)} on the earlier approval.{' '}
              {settlementLines(confirmed).join(' ')}</span>}
        </p>
      )}
      {state && !state.enabled && state.files.length === 0 && (
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Salary bank files are not switched on yet. They stay off until a bank has accepted a test file.
        </p>
      )}
      {state && state.files.length > 0 && (
        <ul className="divide-y divide-[var(--ff-border-primary)] text-sm">
          {state.files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-[var(--ff-text-primary)]">Action date {formatDisplayDate(f.actionDate)}</span>
              <span className="tabular-nums text-[var(--ff-text-primary)]">{formatCurrency(f.totalCents / 100)} · {f.lineCount} {f.lineCount === 1 ? 'payment' : 'payments'}</span>
              <span className="font-mono text-xs text-[var(--ff-text-secondary)]" title={f.sha256}>sha256 {f.sha256.slice(0, 12)}…</span>
              <span className="text-xs text-[var(--ff-text-secondary)]">{statusLabel(f)}</span>
              {canManage && f.status === 'generated' && (
                <span className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => ask(f, 'confirm')}
                    className={`${BTN} bg-success-700 hover:bg-success-800 text-white`}>Bank accepted it</button>
                  <button type="button" disabled={busy} onClick={() => ask(f, 'void')}
                    className={`${BTN} border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]`}>Void</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canGenerate && (
        <p className="text-xs text-[var(--ff-text-secondary)]">
          The file follows FNB&apos;s Bankserv (ACB) import layout (February 2023). It is meant for FNB Online Banking; other banks are not tested.
        </p>
      )}
      {canGenerate && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <DateField label="Action date" value={actionDate} minDate={todayInSast()} onChange={(iso) => setActionDate(iso)} />
          </div>
          <button type="button" disabled={busy || !actionDate} onClick={() => void generate()}
            className={`${BTN} bg-brand-600 hover:bg-brand-700 text-white`}>
            {busy ? 'Generating…' : 'Generate bank file'}
          </button>
        </div>
      )}
      {notice && <p role="status" className="text-sm text-[var(--ff-text-secondary)]">{notice}</p>}
      {warnings.length > 0 && (
        <ul aria-label="Bank file warnings" className="list-disc pl-5 text-sm text-amber-800 dark:text-amber-300">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <Modal open={pending !== null} onClose={() => setPending(null)} size="sm" initialFocusRef={firstButton}
        title={pending?.action === 'confirm' ? 'Record that the bank accepted this file?' : 'Void this bank file?'}>
        <Modal.Body className="text-sm text-[var(--ff-text-secondary)]">
          {pending?.action === 'confirm'
            ? 'Only do this once the bank shows the salaries as accepted. The run is then shown as paid by the bank, and no second file can be made for it.'
            : 'Void it only if it was never uploaded to the bank. A voided file is dead and must never be uploaded; a new file can then be generated.'}
          {pending?.action === 'void' && (
            <label className="mt-3 flex items-start gap-2 text-[var(--ff-text-primary)]">
              <input type="checkbox" checked={notSent} onChange={(e) => setNotSent(e.target.checked)} className="mt-0.5" />
              This file was not sent to the bank.
            </label>
          )}
        </Modal.Body>
        <Modal.Footer>
          <button ref={firstButton} type="button" disabled={busy} onClick={() => setPending(null)}
            className={`${BTN} border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]`}>Cancel</button>
          <button type="button" disabled={busy || (pending?.action === 'void' && !notSent)} onClick={() => void settle()}
            className={`${BTN} text-white ${pending?.action === 'void' ? 'bg-red-700 hover:bg-red-800' : 'bg-success-700 hover:bg-success-800'}`}>
            {pending?.action === 'confirm' ? 'Bank accepted it' : 'Void file'}
          </button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}
