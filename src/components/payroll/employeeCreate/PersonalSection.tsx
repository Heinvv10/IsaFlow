import { FormSection } from '@/components/ui/FormSection';
import { Input } from '@/components/ui/Input';
import { DateField } from '@/components/ui/DateField';
import { todayInSast } from '@/lib/saDateParser';
import type { SectionProps } from './types';

export function PersonalSection({ form, errors, set, fieldRef, setDate }: SectionProps) {
  return (
    <FormSection number={1} title="Personal details" description="Who the employee is.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input ref={fieldRef('firstName')} label="First name *" value={form.firstName} error={errors.firstName}
          onChange={e => set('firstName', e.target.value)} autoComplete="off" />
        <Input ref={fieldRef('lastName')} label="Last name *" value={form.lastName} error={errors.lastName}
          onChange={e => set('lastName', e.target.value)} autoComplete="off" />
        <Input ref={fieldRef('idNumber')} label="SA ID number" value={form.idNumber} placeholder="13 digits" inputMode="numeric"
          error={errors.idNumber} onChange={e => set('idNumber', e.target.value)} />
        <DateField ref={fieldRef('dateOfBirth')} label="Date of birth" value={form.dateOfBirth || null}
          maxDate={todayInSast()} maxMessage="Date of birth cannot be in the future."
          error={errors.dateOfBirth} onChange={setDate('dateOfBirth')} />
      </div>
    </FormSection>
  );
}
