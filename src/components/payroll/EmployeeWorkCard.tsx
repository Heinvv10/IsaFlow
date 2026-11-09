/**
 * Employee work terms card (mig 967): tax status, pay basis, hours, rates, occupation. It saves only these through
 * PATCH /api/payroll/employees/[id], so the profile form's save is untouched. Nothing here moves a figure yet.
 */
import { useState } from 'react';
import { Briefcase } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { TERM_KEYS } from '@/modules/accounting/services/payroll/payrollEmployeeTerms';
import type { TaxStatus } from '@/modules/accounting/services/payroll/payrollTypes';
import { directorStatusPrompt } from '@/modules/accounting/services/payroll/payrollEmployeeTerms';
import type { Employee } from './EmployeeProfileCard';

const TAX_STATUS = [
  { value: 'employee', label: 'Employee' },
  { value: 'director', label: 'Director' },
  { value: 'independent_contractor', label: 'Independent contractor' },
];
const PAY_BASIS = [
  { value: 'monthly', label: 'Monthly salary' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
];

interface Draft { taxStatus: string; payBasis: string; hoursPerWeek: string; hoursPerDay: string; hourlyRate: string; dailyRate: string; occupation: string }

const text = (n: number | null | undefined) => (n == null ? '' : String(n));
const draftOf = (e: Employee): Draft => ({
  taxStatus: e.taxStatus ?? 'employee', payBasis: e.payBasis ?? 'monthly', hoursPerWeek: text(e.hoursPerWeek),
  hoursPerDay: text(e.hoursPerDay), hourlyRate: text(e.hourlyRate), dailyRate: text(e.dailyRate), occupation: e.occupation ?? '',
});
/** Blank clears; anything else goes as a number, and the server judges it. */
const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
const NUMERIC: Array<[keyof Draft, string]> = [['hoursPerWeek', 'Hours a week'], ['hoursPerDay', 'Hours a day'], ['hourlyRate', 'Hourly rate'], ['dailyRate', 'Daily rate']];

interface Props {
  employee: Employee;
  onSaved: (e: Employee) => void;
  /** Owner or admin: tax status, pay basis and rates are priced, and the API refuses them (403) to anyone else. */
  canEditPriced: boolean;
}

export function EmployeeWorkCard({ employee, onSaved, canEditPriced }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(employee));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof Draft) => (v: string) => setDraft(d => ({ ...d, [k]: v }));
  const prompt = directorStatusPrompt({ employmentType: employee.employmentType, taxStatus: draft.taxStatus as TaxStatus });
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(employee));

  async function save(): Promise<void> {
    // Text that is not a number would reach the server as null and silently clear the value: refuse it here.
    const unreadable = NUMERIC.find(([k]) => draft[k].trim() !== '' && !Number.isFinite(Number(draft[k])));
    if (unreadable) {
      setError(`${unreadable[1]} must be a number.`);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const all = {
        taxStatus: draft.taxStatus, payBasis: draft.payBasis, hoursPerWeek: numberOrNull(draft.hoursPerWeek),
        hoursPerDay: numberOrNull(draft.hoursPerDay), hourlyRate: numberOrNull(draft.hourlyRate),
        dailyRate: numberOrNull(draft.dailyRate), occupation: draft.occupation.trim() || null,
      };
      // Only what changed: an occupation-only edit must not take the payroll lock or touch the priced terms.
      const saved = draftOf(employee);
      const changed = (Object.keys(draft) as Array<keyof Draft>).filter(k => draft[k] !== saved[k]);
      const terms = Object.fromEntries(changed.map(k => [k, all[k]]));
      const res = await apiFetch(`/api/payroll/employees/${employee.id}`, { method: 'PATCH', body: JSON.stringify(terms) });
      await assertOk(res, 'Could not save the work terms - try again');
      // What the server stored, not what was typed.
      const stored = ((await res.json()) as { data?: Partial<Employee> }).data ?? {};
      onSaved({ ...employee, ...Object.fromEntries(TERM_KEYS.filter(k => k in stored).map(k => [k, stored[k]])) } as Employee);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the work terms - try again'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5" data-testid="employee-work-card">
      <div className="flex items-center gap-2 mb-4">
        <Briefcase className="h-5 w-5 text-sky-500" />
        <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Work terms</h3>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select label="Tax status" options={TAX_STATUS} value={draft.taxStatus} disabled={!canEditPriced} onChange={v => v && set('taxStatus')(v)} />
        <Select label="Pay basis" options={PAY_BASIS} value={draft.payBasis} disabled={!canEditPriced} onChange={v => v && set('payBasis')(v)} />
        <Input label="Hours a week" type="number" min={0} max={168} step="0.01" value={draft.hoursPerWeek} onChange={e => set('hoursPerWeek')(e.target.value)} />
        <Input label="Hours a day" type="number" min={0} max={24} step="0.01" value={draft.hoursPerDay} onChange={e => set('hoursPerDay')(e.target.value)} />
        <Input label="Hourly rate (R)" type="number" min={0} step="0.01" disabled={!canEditPriced} value={draft.hourlyRate} onChange={e => set('hourlyRate')(e.target.value)} />
        <Input label="Daily rate (R)" type="number" min={0} step="0.01" disabled={!canEditPriced} value={draft.dailyRate} onChange={e => set('dailyRate')(e.target.value)} />
        <Input label="Occupation" maxLength={100} value={draft.occupation} onChange={e => set('occupation')(e.target.value)} />
      </div>
      {!canEditPriced && (
        <p className="mt-3 text-sm text-[var(--ff-text-secondary)]" data-testid="priced-terms-hint">
          Only an owner or admin can change the tax status, pay basis and rates. Hours and occupation you can edit.
        </p>
      )}
      {prompt && canEditPriced && (
        <div role="status" className="mt-4 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <span>This employee is a director by employment type, but the tax status is Employee.</span>
          <Button size="sm" variant="secondary" onClick={() => set('taxStatus')('director')}>{prompt}</Button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={!dirty} loading={saving}>Save work terms</Button>
      </div>
    </div>
  );
}
