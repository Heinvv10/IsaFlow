/**
 * The employee's pay frequency (wave 6 FQd; grill F16: its own field and route, mounted on the work card by one line).
 * Reads /api/payroll/employees/[id]/pay-frequency; only an owner or admin may change it (the route refuses anyone
 * else). The server refuses a change once the employee is on an approved run this tax year, and weekly or fortnightly
 * pay for terms calculate cannot cost; its message is shown as is. A failed load offers Retry, which re-runs the GET.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

const LOAD_FAILED = 'Could not load the pay frequency';
const SAVE_FAILED = 'Could not save the pay frequency - try again';
const OPTIONS = [
  { value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' },
];

/** The route's `{ payFrequency }`, checked at run time (the route is not in the apiRoutes registry). */
export function payFrequencyOfResponse(data: unknown): string {
  const f = (data as { payFrequency?: unknown } | null)?.payFrequency;
  if (typeof f === 'string') return f;
  throw new Error('Unexpected response');
}

export function PayFrequencyField({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const [saved, setSaved] = useState<string | undefined>(undefined);
  /** null until the frequency loads: the select shows its placeholder, never a value that looks real (review #1622 UI L2). */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  /** Bumped by Retry: re-runs the load after a failed GET (the field stays disabled until it loads). */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    apiJson(`/api/payroll/employees/${employeeId}/pay-frequency`, undefined, LOAD_FAILED)
      .then((d) => { if (live) { const f = payFrequencyOfResponse(d); setSaved(f); setDraft(f); } })
      .catch((err: unknown) => { if (live) setError(apiErrorMessage(err, LOAD_FAILED)); });
    return () => { live = false; };
  }, [employeeId, attempt]);

  function retry(): void {
    setError('');
    setAttempt((n) => n + 1);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    setDone(false);
    try {
      const f = payFrequencyOfResponse(await apiJson(`/api/payroll/employees/${employeeId}/pay-frequency`,
        { method: 'PUT', body: JSON.stringify({ payFrequency: draft }) }, SAVE_FAILED));
      setSaved(f);
      setDraft(f);
      setDone(true);
    } catch (err) {
      // Refused: the select goes back to what is saved, so it never shows an unsaved value as if it held (UI L1).
      setDraft(saved ?? null);
      setError(apiErrorMessage(err, SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 border-t border-[var(--ff-border-primary)] pt-4" data-testid="pay-frequency-field">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Select label="Pay frequency" options={OPTIONS} value={draft} placeholder={error && saved === undefined ? 'Not loaded' : 'Loading…'}
            disabled={saved === undefined || !canEdit}
            onChange={(v) => { if (v) { setDraft(v); setDone(false); } }} />
          <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
            {canEdit ? 'A run pays only the employees of its own frequency. It can change only at the start of a tax year once the employee is paid.'
              : 'Only an owner or admin can change the pay frequency.'}
          </p>
        </div>
        {canEdit && <Button variant="secondary" onClick={() => void save()} disabled={saved === undefined || draft === saved} loading={saving}>Save frequency</Button>}
      </div>
      {done && <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Pay frequency saved.</p>}
      {error && (
        <div className="mt-2 flex items-center gap-3">
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>
          {saved === undefined && <Button variant="secondary" size="sm" onClick={retry}>Retry</Button>}
        </div>
      )}
    </div>
  );
}
