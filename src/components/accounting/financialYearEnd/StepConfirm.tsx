import { useState } from 'react';
import { log } from '@/lib/logger';
import { apiErrorMessage } from '@/lib/apiFetch';
import { INPUT_CLS } from '@/components/accounting/settings/settingsTypes';
import { BTN_PRIMARY, BTN_SECONDARY, CARD_CLS, MIN_REASON, YearEndRefusedError, fmtDay, sendYearEndChange } from './yearEndTypes';

interface Props {
  month: number;
  kind: 'shorten' | 'extend' | undefined;
  endDate: string;
  onBack: () => void;
  onApplied: () => void;
}

export function StepConfirm({ month, kind, endDate, onBack, onApplied }: Props) {
  const [reason, setReason] = useState('');
  const [cipc, setCipc] = useState(false);
  const [sars, setSars] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refusals, setRefusals] = useState<string[]>([]);
  const ready = reason.trim().length >= MIN_REASON && cipc && sars && !saving;

  async function apply() {
    setSaving(true);
    setError('');
    setRefusals([]);
    try {
      await sendYearEndChange('POST', {
        newYearEndMonth: month, kind, reason: reason.trim(), cipcFiledConfirmed: cipc, sarsNotifiedConfirmed: sars,
      });
      onApplied();
    } catch (err) {
      log.error('Year-end change failed', { error: err }, 'financial-year-end-change');
      if (err instanceof YearEndRefusedError) setRefusals(err.refusals);
      setError(apiErrorMessage(err, 'The change could not be applied - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={CARD_CLS} data-testid="step-confirm">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-2">3. Confirm</h2>
      <p className="text-sm text-[var(--ff-text-secondary)] mb-4">The current financial year will end on {fmtDay(endDate)}.</p>
      <label htmlFor="change-reason" className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reason for the change (at least {MIN_REASON} characters)</label>
      <textarea id="change-reason" data-testid="change-reason" rows={3} className={INPUT_CLS} value={reason} onChange={e => setReason(e.target.value)} />
      <label className="flex items-start gap-2 mt-4 text-sm text-[var(--ff-text-primary)]">
        <input type="checkbox" data-testid="confirm-cipc" checked={cipc} onChange={e => setCipc(e.target.checked)} className="mt-1" />
        The notice of change has been filed with CIPC
      </label>
      <label className="flex items-start gap-2 mt-2 text-sm text-[var(--ff-text-primary)]">
        <input type="checkbox" data-testid="confirm-sars" checked={sars} onChange={e => setSars(e.target.checked)} className="mt-1" />
        SARS has been notified
      </label>
      {error && (
        <div role="alert" data-testid="apply-error" className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          <p>{error}</p>
          {refusals.length > 0 && <ul className="list-disc pl-5 mt-1 space-y-1">{refusals.map(r => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
      <div className="flex gap-2 mt-6">
        <button type="button" className={BTN_SECONDARY} onClick={onBack} disabled={saving}>Back</button>
        <button type="button" data-testid="apply-change" className={BTN_PRIMARY} disabled={!ready} onClick={() => void apply()}>
          {saving ? 'Applying...' : 'Apply change'}
        </button>
      </div>
    </section>
  );
}
