import { FormSection } from '@/components/ui/FormSection';
import { Input } from '@/components/ui/Input';
import type { SectionProps } from './types';

export function TaxAndMedicalSection({ form, errors, set, fieldRef, checkField }: SectionProps) {
  return (
    <FormSection
      number={3}
      title="Tax and medical aid"
      description="Used for PAYE and the medical aid tax credit."
      help={{ text: 'The SARS tax number is the 10-digit reference on the IRP5. Medical aid main member and dependants set the monthly medical tax credit.' }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input ref={fieldRef('taxNumber')} label="SARS tax number" value={form.taxNumber} placeholder="10 digits" inputMode="numeric"
          error={errors.taxNumber} onChange={e => set('taxNumber', e.target.value.replace(/\s/g, ''))} onBlur={() => checkField('taxNumber')} />
        <Input label="Medical aid dependants" type="number" min="0" value={form.medicalAidDependantsCount}
          onChange={e => set('medicalAidDependantsCount', e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
          <input type="checkbox" checked={form.medicalAidMainMember} onChange={e => set('medicalAidMainMember', e.target.checked)} />
          Medical aid main member
        </label>
      </div>
    </FormSection>
  );
}
