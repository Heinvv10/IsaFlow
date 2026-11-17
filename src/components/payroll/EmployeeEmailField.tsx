/**
 * The employee's payslip email address (wave 6 PE; grill F16: its own field and route, mounted on the work card by
 * one line). Reads and saves /api/payroll/employees/[id]/email; the server judges the address (one plain address
 * or blank) and audits the change. Payroll-detail roles only (the route refuses the rest).
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

const LOAD_FAILED = 'Could not load the payslip email address';
const SAVE_FAILED = 'Could not save the payslip email address - try again';

/** The route's `{ email }`, checked at run time (the route is not in the apiRoutes registry). */
export function emailOf(data: unknown): string | null {
  const email = (data as { email?: unknown } | null)?.email;
  if (email === null || typeof email === 'string') return email;
  throw new Error('Unexpected response');
}

export function EmployeeEmailField({ employeeId }: { employeeId: string }) {
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    apiJson(`/api/payroll/employees/${employeeId}/email`, undefined, LOAD_FAILED)
      .then((d) => { if (live) { const e = emailOf(d); setSaved(e); setDraft(e ?? ''); } })
      .catch((err: unknown) => { if (live) { setSaved(null); setError(apiErrorMessage(err, LOAD_FAILED)); } });
    return () => { live = false; };
  }, [employeeId]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    setDone(false);
    try {
      const d = await apiJson(`/api/payroll/employees/${employeeId}/email`,
        { method: 'PUT', body: JSON.stringify({ email: draft.trim() || null }) }, SAVE_FAILED);
      const e = emailOf(d);
      setSaved(e);
      setDraft(e ?? '');
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  }

  const dirty = saved !== undefined && draft.trim() !== (saved ?? '');
  return (
    <div className="mt-4 border-t border-[var(--ff-border-primary)] pt-4" data-testid="employee-email-field">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input label="Payslip email" type="email" autoComplete="off" maxLength={254} value={draft}
            disabled={saved === undefined} onChange={(e) => { setDraft(e.target.value); setDone(false); }}
            helperText="Where this employee's payslips are emailed, when payslip email is on. Leave blank for none." />
        </div>
        <Button variant="secondary" onClick={() => void save()} disabled={!dirty} loading={saving}>Save email</Button>
      </div>
      {done && <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Payslip email saved.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
