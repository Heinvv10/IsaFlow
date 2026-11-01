import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { FormSection } from '@/components/ui/FormSection';
import { MoneyField } from '@/components/ui/MoneyField';
import { Select } from '@/components/ui/Select';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { MAX_SALARY_CENTS } from '@/modules/accounting/services/payroll/employeeFieldRules';
import { defaultSalaryComponent, firstMonthNotes, hasBasicSalary, salaryComponents, type SalaryComponent } from './salaryComponents';
import type { SectionProps } from './types';

const PICKER_ID = 'salary-component';

interface Props extends SectionProps {
  setSalary: (cents: number | null, validity: FieldValidity) => void;
}

export function PaySection({ form, errors, set, fieldRef, setSalary }: Props) {
  const [components, setComponents] = useState<SalaryComponent[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const chosen = useRef(form.salaryComponentId);
  useEffect(() => { chosen.current = form.salaryComponentId; });

  const load = useCallback(async (isStale: () => boolean) => {
    try {
      const res = await apiFetch('/api/payroll/components');
      await assertOk(res, 'Could not load the pay components');
      const json = await res.json();
      const data: unknown = json.data ?? json;
      if (!Array.isArray(data)) throw new Error('Could not load the pay components');
      if (isStale()) return;
      const eligible = salaryComponents(data as SalaryComponent[]);
      setLoadError('');
      setComponents(eligible);
      const pick = defaultSalaryComponent(eligible);
      if (pick && !chosen.current) set('salaryComponentId', pick);
    } catch (err) {
      log.warn('pay components failed to load', { error: err }, 'PaySection');
      if (!isStale()) setLoadError('Could not load the pay components. You can still create the employee and add pay on the profile.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `set` only applies an update to the form
  }, []);

  useEffect(() => {
    let stale = false;
    void load(() => stale);
    return () => { stale = true; };
  }, [load]);

  // The link below opens Pay Components in a new tab: coming back has to show what was added there, or the only way
  // to see it would be the reload that loses this form.
  const noBasic = components !== null && !hasBasicSalary(components);
  useEffect(() => {
    if (!noBasic) return undefined;
    let stale = false;
    const reload = () => { void load(() => stale); };
    window.addEventListener('focus', reload);
    return () => { stale = true; window.removeEventListener('focus', reload); };
  }, [noBasic, load]);

  const offered = components !== null && components.length > 0;
  // Select keeps its trigger to itself; the form's focus-the-first-error goes through this id.
  useEffect(() => {
    if (offered) fieldRef('salaryComponentId')(document.getElementById(PICKER_ID));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the picker appears
  }, [offered]);

  const notes = form.salaryCents !== null && form.startDate ? firstMonthNotes(form.startDate, todayInSast()) : [];

  return (
    <FormSection
      number={4}
      title="Pay"
      description="Optional. Leave it blank and add pay on the profile later."
      help={{ text: 'The salary repeats every month until it is ended on the profile. A start date on or before the 27th is paid the full month in that month\'s run, with no part-month reduction; a later one is first paid the next month.' }}
    >
      {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
      {!loadError && components === null && <p className="text-sm text-[var(--ff-text-secondary)]">Loading pay components…</p>}
      {noBasic && (
        <p className="mb-3 text-sm text-[var(--ff-text-secondary)]">
          This company has no active, taxable Basic Salary component.{' '}
          <Link href="/payroll/components" target="_blank" rel="noopener noreferrer" className="text-teal-700 underline dark:text-teal-400">
            Add one (opens in a new tab)
          </Link>
        </p>
      )}
      {offered && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MoneyField ref={fieldRef('salaryCents')} label="Monthly salary" value={form.salaryCents} min={1} max={MAX_SALARY_CENTS}
            error={errors.salaryCents} onChange={setSalary} />
          <Select id={PICKER_ID} label="Pay component" searchable value={form.salaryComponentId || null} error={errors.salaryComponentId}
            options={components.map(c => ({ value: c.id, label: `${c.name} (${c.sarsSourceCode.trim()})` }))}
            onChange={v => set('salaryComponentId', v ?? '')} />
          {notes.map(note => (
            <p key={note} role="status" className="text-sm text-amber-800 sm:col-span-2 dark:text-amber-300">{note}</p>
          ))}
        </div>
      )}
    </FormSection>
  );
}
