/**
 * The tax status on the work card, with a personal service provider's entity type (wave 6 PSP; grill F16: its own file,
 * mounted on EmployeeWorkCard by one line). The entity picks the rate (SARS PAYE-GEN-01-G01-A06 row 6: 27% for a
 * company or close corporation, 45% for a trust); the server judges the pair (payrollEmployeeTaxStatus) and only an
 * owner or admin may change either (priced terms).
 */
import { Select } from '@/components/ui/Select';

export const TAX_STATUS_OPTIONS = [
  { value: 'employee', label: 'Employee' },
  { value: 'director', label: 'Director' },
  { value: 'independent_contractor', label: 'Independent contractor' },
  { value: 'personal_service_provider', label: 'Personal service provider' },
];
const PSP_ENTITY_OPTIONS = [
  { value: 'company', label: 'Company or close corporation (27%)' },
  { value: 'trust', label: 'Trust (45%)' },
];

export interface TaxStatusValue { taxStatus: string; pspEntityType: string }

interface Props extends TaxStatusValue {
  disabled: boolean;
  onChange: (next: TaxStatusValue) => void;
}

export function PayrollTaxStatusField({ taxStatus, pspEntityType, disabled, onChange }: Props) {
  const psp = taxStatus === 'personal_service_provider';
  return (
    <>
      <Select label="Tax status" options={TAX_STATUS_OPTIONS} value={taxStatus} disabled={disabled}
        onChange={v => v && onChange({ taxStatus: v, pspEntityType: v === 'personal_service_provider' ? pspEntityType : '' })} />
      {psp && (
        <div data-testid="psp-entity-field">
          <Select label="Personal service provider is a" options={PSP_ENTITY_OPTIONS} value={pspEntityType} disabled={disabled}
            placeholder="Company or trust" required onChange={v => v && onChange({ taxStatus, pspEntityType: v })} />
          <p className="mt-1 text-xs text-[var(--ff-text-secondary)]">
            PAYE at the entity&apos;s income tax rate (SARS PAYE-GEN-01-G01-A06), not the tables. No UIF or ETI; SDL applies.
          </p>
        </div>
      )}
    </>
  );
}
