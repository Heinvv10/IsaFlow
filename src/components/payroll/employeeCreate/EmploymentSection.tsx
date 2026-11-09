import { FormSection } from '@/components/ui/FormSection';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { DateField } from '@/components/ui/DateField';
import type { EmploymentType, SectionProps, TaxStatus } from './types';

const TYPES: { value: EmploymentType; label: string }[] = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'contract', label: 'Contract' },
  { value: 'casual', label: 'Casual' },
  { value: 'director', label: 'Director' },
];

const STATUSES: { value: TaxStatus; label: string }[] = [
  { value: 'employee', label: 'Employee' },
  { value: 'director', label: 'Director' },
  { value: 'independent_contractor', label: 'Independent contractor' },
];

export function EmploymentSection({ form, errors, set, fieldRef, setDate }: SectionProps) {
  return (
    <FormSection number={2} title="Employment" description="How and when they work for you.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input ref={fieldRef('employeeNumber')} label="Employee number *" value={form.employeeNumber}
          error={errors.employeeNumber} onChange={e => set('employeeNumber', e.target.value)} autoComplete="off" />
        <Select label="Employment type" searchable options={TYPES} value={form.employmentType}
          onChange={v => v && set('employmentType', v as EmploymentType)} />
        <Select label="Tax status" options={STATUSES} value={form.taxStatus}
          onChange={v => v && set('taxStatus', v as TaxStatus)} />
        <Input label="Occupation" value={form.occupation} maxLength={100} onChange={e => set('occupation', e.target.value)} />
        <DateField ref={fieldRef('startDate')} label="Start date" required value={form.startDate || null}
          error={errors.startDate} onChange={setDate('startDate')} />
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-gray-900 dark:text-gray-100">
          <input type="checkbox" checked={form.uifExcluded} onChange={e => set('uifExcluded', e.target.checked)} />
          Excluded from UIF
        </label>
      </div>
    </FormSection>
  );
}
