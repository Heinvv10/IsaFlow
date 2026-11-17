/**
 * The company's pay week (wave 6 FQd; grill F17): the day a pay week starts, the day it is paid, and the start of one
 * fortnight. Shown on the new-run page for weekly and fortnightly runs. Only an owner or admin may change it (the
 * route refuses anyone else), and a final weekly or fortnightly run this tax year fixes it (409 PAY_WEEK_LOCKED).
 */
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { DateField } from '@/components/ui/DateField';
import { Select } from '@/components/ui/Select';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { DAY_NAMES, type PayWeekSettings } from '@/modules/accounting/services/payroll/payrollPayWeek';

export interface PayWeekState extends PayWeekSettings {
  locked: { week: boolean; anchor: boolean };
}

const SAVE_FAILED = 'Could not save the pay week - try again';
const DAYS = DAY_NAMES.map((n, i) => ({ value: String(i + 1), label: n }));
/** The three settings only: the route refuses any other key (the state's `locked` is not one). */
const settingsOf = (s: PayWeekSettings): PayWeekSettings =>
  ({ payWeekStartDow: s.payWeekStartDow, payWeekday: s.payWeekday, fortnightAnchor: s.fortnightAnchor ?? null });

/** The route's state, checked at run time (the route is not in the apiRoutes registry). */
export function payWeekOf(data: unknown): PayWeekState {
  const d = data as Partial<PayWeekState> | null;
  if (!d || typeof d.payWeekStartDow !== 'number' || typeof d.payWeekday !== 'number' || !d.locked
    || (d.fortnightAnchor !== null && typeof d.fortnightAnchor !== 'string')) throw new Error('Unexpected response');
  return d as PayWeekState;
}

export function PayWeekSettingsCard({ state, canEdit, onSaved }: {
  state: PayWeekState; canEdit: boolean; onSaved: (s: PayWeekState) => void;
}) {
  const [draft, setDraft] = useState<PayWeekSettings>(() => settingsOf(state));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = draft.payWeekStartDow !== state.payWeekStartDow || draft.payWeekday !== state.payWeekday
    || (draft.fortnightAnchor ?? null) !== (state.fortnightAnchor ?? null);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const saved = payWeekOf(await apiJson('/api/payroll/settings/pay-week', { method: 'PUT', body: JSON.stringify(draft) }, SAVE_FAILED));
      setDraft(settingsOf(saved));
      onSaved(saved);
    } catch (err) {
      setError(apiErrorMessage(err, SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  }

  const weekFixed = !canEdit || state.locked.week;
  return (
    <section aria-labelledby="pay-week-title" className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4" data-testid="pay-week-card">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-5 w-5 text-sky-500" aria-hidden="true" />
        <h2 id="pay-week-title" className="text-sm font-semibold text-[var(--ff-text-primary)]">Pay week</h2>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select label="Week starts on" options={DAYS} value={String(draft.payWeekStartDow)} disabled={weekFixed}
          onChange={(v) => v && setDraft((d) => ({ ...d, payWeekStartDow: Number(v) }))} />
        <Select label="Paid on" options={DAYS} value={String(draft.payWeekday)} disabled={weekFixed}
          onChange={(v) => v && setDraft((d) => ({ ...d, payWeekday: Number(v) }))} />
        <div className="sm:col-span-2">
          <DateField label="A fortnight starts on (fortnightly runs)" value={draft.fortnightAnchor}
            disabled={!canEdit || state.locked.anchor}
            onChange={(iso) => setDraft((d) => ({ ...d, fortnightAnchor: iso }))} />
        </div>
      </div>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        {state.locked.week
          ? 'Fixed for this tax year: a weekly or fortnightly run paid on it is approved. It can change from 1 March.'
          : canEdit ? 'Fixed for the tax year once a weekly or fortnightly run is approved.'
            : 'Only an owner or admin can change the pay week.'}
      </p>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {canEdit && !(state.locked.week && state.locked.anchor) && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => void save()} disabled={!dirty} loading={saving}>Save pay week</Button>
        </div>
      )}
    </section>
  );
}
