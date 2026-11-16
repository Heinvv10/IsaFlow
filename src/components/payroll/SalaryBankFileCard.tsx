/**
 * SalaryBankFileCard — the salary bank file of an approved pay run (wave 6 BF). Generate the ACB file for an action
 * date (downloaded from memory; owner / admin), then record that the bank accepted it (confirm) or void it. A confirmed
 * file shows the run as payment-confirmed; the run stays approved and can still be reopened, with a warning.
 * Shown for approved and paid runs; re-read whenever the run's status changes (a reopen makes a file stale).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Banknote, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { todayInSast } from '@/lib/saDateParser';
import { formatCurrency } from '@/utils/formatters';
import { formatDisplayDate } from '@/utils/dateFormat';
import { DateField } from '@/components/ui/DateField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { PayrollBankFile, RunBankFileState } from '@/modules/accounting/services/payroll/payrollBankFileStatus';

const LOAD_FAILED = 'Could not load the salary bank file - try again';
const BTN = 'px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50';

function statusLabel(f: PayrollBankFile): string {
  if (f.status === 'confirmed') return 'Payment confirmed';
  if (f.status === 'voided') return 'Voided';
  return f.stale ? 'Out of date: the run was reopened' : 'Generated, not yet confirmed';
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
    setBusy(true); setError(''); setWarnings([]);
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
      const res = await apiFetch(`/api/payroll/runs/${runId}/bank-file/${pending.file.id}/${pending.action}`, { method: 'POST' });
      await assertOk(res, `Could not ${pending.action} the bank file - try again`);
    } catch (err) {
      setError(apiErrorMessage(err, `Could not ${pending.action} the bank file - try again`));
    } finally {
      setPending(null); setBusy(false);
      void load();
    }
  };

  const live = state?.files.find((f) => f.status === 'generated' && !f.stale);
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
          The bank has paid this run (file confirmed {confirmed.confirmedAt ? formatDisplayDate(confirmed.confirmedAt.slice(0, 10)) : ''}).
          Reopening the run does not reverse that payment: pay any difference separately.
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
              <span className="tabular-nums text-[var(--ff-text-primary)]">{formatCurrency(f.totalCents / 100)} · {f.lineCount} payments</span>
              <span className="text-xs text-[var(--ff-text-secondary)]">{statusLabel(f)}</span>
              {canManage && f.status === 'generated' && (
                <span className="flex gap-2">
                  {!f.stale && (
                    <button type="button" disabled={busy} onClick={() => setPending({ file: f, action: 'confirm' })}
                      className={`${BTN} bg-success-700 hover:bg-success-800 text-white`}>Bank accepted it</button>
                  )}
                  <button type="button" disabled={busy} onClick={() => setPending({ file: f, action: 'void' })}
                    className={`${BTN} border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]`}>Void</button>
                </span>
              )}
            </li>
          ))}
        </ul>
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
      {warnings.length > 0 && (
        <ul aria-label="Bank file warnings" className="list-disc pl-5 text-sm text-amber-800 dark:text-amber-300">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <ConfirmDialog open={pending !== null} loading={busy}
        title={pending?.action === 'confirm' ? 'Record that the bank accepted this file?' : 'Void this bank file?'}
        message={pending?.action === 'confirm'
          ? 'Only do this once the bank shows the salaries as accepted. The run is then shown as paid by the bank, and no second file can be made for it.'
          : 'Void it only if it was never uploaded to the bank. A new file can then be generated.'}
        acceptLabel={pending?.action === 'confirm' ? 'Bank accepted it' : 'Void file'}
        tone={pending?.action === 'void' ? 'destructive' : 'default'}
        onAccept={() => void settle()} onCancel={() => setPending(null)} />
    </section>
  );
}
