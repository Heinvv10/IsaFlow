import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { FormSection } from '@/components/ui/FormSection';
import { MoneyField } from '@/components/ui/MoneyField';
import { Select } from '@/components/ui/Select';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { defaultSalaryComponent, hasBasicSalary, salaryComponents, type SalaryComponent } from './salaryComponents';
import type { SectionProps } from './types';

const PICKER_ID = 'salary-component';

interface Props extends SectionProps {
  setSalary: (cents: number | null, validity: FieldValidity) => void;
}

export function PaySection({ form, errors, set, fieldRef, setSalary }: Props) {
  const [components, setComponents] = useState<SalaryComponent[] | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let stale = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/payroll/components');
        await assertOk(res, 'Could not load the pay components');
        const json = await res.json();
        const data: unknown = json.data ?? json;
        if (!Array.isArray(data)) throw new Error('Could not load the pay components');
        if (stale) return;
        const eligible = salaryComponents(data as SalaryComponent[]);
        setComponents(eligible);
        const pick = defaultSalaryComponent(eligible);
        if (pick) set('salaryComponentId', pick);
      } catch (err) {
        log.warn('pay components failed to load', { error: err }, 'PaySection');
        if (!stale) setLoadError('Could not load the pay components. You can still create the employee and add pay on the profile.');
      }
    };
    void load();
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once: `set` only applies an update to the form
  }, []);

  const offered = components !== null && components.length > 0;
  // Select keeps its trigger to itself; the form's focus-the-first-error goes through this id.
  useEffect(() => {
    if (offered) fieldRef('salaryComponentId')(document.getElementById(PICKER_ID));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the picker appears
  }, [offered]);

  return (
    <FormSection
      number={4}
      title="Pay"
      description="Optional. Leave it blank and add pay on the profile later."
      help={{ text: 'The salary starts on the start date and repeats every month until it is ended on the profile.' }}
    >
      {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}
      {!loadError && components === null && <p className="text-sm text-[var(--ff-text-secondary)]">Loading pay components…</p>}
      {components !== null && !hasBasicSalary(components) && (
        <p className="mb-3 text-sm text-[var(--ff-text-secondary)]">
          <Link href="/payroll/components" className="text-teal-700 underline dark:text-teal-400">Create a Basic Salary component first</Link>
        </p>
      )}
      {offered && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MoneyField ref={fieldRef('salaryCents')} label="Monthly salary" value={form.salaryCents} min={1}
            error={errors.salaryCents} onChange={setSalary} />
          <Select id={PICKER_ID} label="Pay component" value={form.salaryComponentId || null} error={errors.salaryComponentId}
            options={components.map(c => ({ value: c.id, label: `${c.name} (${c.sarsSourceCode.trim()})` }))}
            onChange={v => set('salaryComponentId', v ?? '')} />
        </div>
      )}
    </FormSection>
  );
}
