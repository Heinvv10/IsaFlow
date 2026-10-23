import { useState } from 'react';
import { log } from '@/lib/logger';
import { apiErrorMessage } from '@/lib/apiFetch';
import type { YearEndChangeRecord } from '@/modules/accounting/services/gl/financialYearEndChangeUndo';
import { INPUT_CLS } from '@/components/accounting/settings/settingsTypes';
import { BTN_PRIMARY, BTN_SECONDARY, CARD_CLS, MIN_REASON, YearEndRefusedError, fmtDay, sendYearEndChange, fmtInstantDay } from './yearEndTypes';

interface Props {
  history: YearEndChangeRecord[];
  undo: { changeId: string | null; refusals: string[] };
  onUndone: () => void;
}

export function HistoryPanel({ history, undo, onUndone }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refusals, setRefusals] = useState<string[]>([]);

  async function confirmUndo() {
    setSaving(true);
    setError('');
    setRefusals([]);
    try {
      await sendYearEndChange('DELETE', { reason: reason.trim() });
      setOpen(false);
      setReason('');
      onUndone();
    } catch (err) {
      log.error('Year-end undo failed', { error: err }, 'financial-year-end-change');
      if (err instanceof YearEndRefusedError) setRefusals(err.refusals);
      setError(apiErrorMessage(err, 'The change could not be undone - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={CARD_CLS} data-testid="change-history">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Change history</h2>
      {history.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-secondary)]">No changes of financial year end have been made.</p>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-[var(--ff-text-secondary)]"><th className="py-1">Applied</th><th>Year end</th><th>Months</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>{history.map(h => (
            <tr key={h.id} className="border-t border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] align-top">
              <td className="py-1">{fmtInstantDay(h.appliedAt)}</td>
              <td>{fmtDay(h.fromEndDate)} to {fmtDay(h.toEndDate)}</td>
              <td>{h.months}</td>
              <td>{h.reason}</td>
              <td>{h.reversedAt ? `Undone: ${h.reversalReason ?? ''}` : 'In effect'}</td>
            </tr>))}</tbody>
        </table>
      )}

      {undo.changeId && (
        <div className="mt-4">
          {undo.refusals.length > 0 ? (
            <div data-testid="undo-refusals" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-400">
              <p className="font-semibold mb-1">The latest change cannot be undone</p>
              <ul className="list-disc pl-5 space-y-1">{undo.refusals.map(r => <li key={r}>{r}</li>)}</ul>
            </div>
          ) : !open ? (
            <button type="button" data-testid="undo-change" className={BTN_SECONDARY} onClick={() => setOpen(true)}>Undo latest change</button>
          ) : (
            <div data-testid="undo-form">
              <p data-testid="undo-allowance-note" className="mb-2 text-sm text-[var(--ff-text-secondary)]">
                Undoing restores the books, but the notice already filed with CIPC still counts: the year end
                cannot be changed again during this financial year (Companies Act s27(4)(a)).
              </p>
              <label htmlFor="undo-reason" className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reason for undoing (at least {MIN_REASON} characters)</label>
              <textarea id="undo-reason" data-testid="undo-reason" rows={3} className={INPUT_CLS} value={reason} onChange={e => setReason(e.target.value)} />
              {error && (
                <div role="alert" data-testid="undo-error" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
                  <p>{error}</p>
                  {refusals.length > 0 && <ul className="list-disc pl-5 mt-1">{refusals.map(r => <li key={r}>{r}</li>)}</ul>}
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <button type="button" className={BTN_SECONDARY} disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" data-testid="undo-confirm" className={BTN_PRIMARY} disabled={saving || reason.trim().length < MIN_REASON} onClick={() => void confirmUndo()}>
                  {saving ? 'Undoing...' : 'Confirm undo'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
