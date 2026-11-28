import { FormSection } from '@/components/ui/FormSection';
import { Input } from '@/components/ui/Input';
import { DateField } from '@/components/ui/DateField';
import { todayInSast } from '@/lib/saDateParser';
import type { SectionProps } from './types';
import { AddressFields } from '../AddressFields';
import { addressIsBlank, type AddressErrors, type AddressFieldKey, type AddressForm } from '../addressForm';

/** The address part (wave 7 EA1): optional; once anything is typed it is checked as the profile checks it. */
export interface AddressSlot {
  form: AddressForm;
  errors: AddressErrors;
  onChange: (key: AddressFieldKey, path: string, value: string) => void;
  onSameChange: (same: boolean) => void;
  fieldRef: (key: AddressFieldKey) => (el: HTMLInputElement | null) => void;
}

export function PersonalSection({ form, errors, set, fieldRef, setDate, checkField, address }: SectionProps & { address: AddressSlot }) {
  return (
    <FormSection number={1} title="Personal details" description="Who the employee is.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input ref={fieldRef('firstName')} label="First name *" value={form.firstName} error={errors.firstName}
          onChange={e => set('firstName', e.target.value)} autoComplete="off" />
        <Input ref={fieldRef('lastName')} label="Last name *" value={form.lastName} error={errors.lastName}
          onChange={e => set('lastName', e.target.value)} autoComplete="off" />
        <Input ref={fieldRef('idNumber')} label="SA ID number" value={form.idNumber} placeholder="13 digits" inputMode="numeric"
          error={errors.idNumber} onChange={e => set('idNumber', e.target.value.replace(/\s/g, ''))} onBlur={() => checkField('idNumber')} />
        <DateField ref={fieldRef('dateOfBirth')} label="Date of birth" value={form.dateOfBirth || null}
          maxDate={todayInSast()} maxMessage="Date of birth cannot be in the future."
          error={errors.dateOfBirth} onChange={setDate('dateOfBirth')} />
      </div>
      <div className="mt-6 space-y-4" data-testid="create-address">
        <p className="text-sm text-[var(--ff-text-secondary)]">Address (optional; the IRP5 certificate needs it). Once you type any of it, the street, a suburb or city, and for a South African address the postal code, are needed.</p>
        <AddressFields form={address.form} errors={address.errors} required={!addressIsBlank(address.form)} onChange={address.onChange}
          onSameChange={address.onSameChange} fieldRef={address.fieldRef} />
      </div>
    </FormSection>
  );
}
