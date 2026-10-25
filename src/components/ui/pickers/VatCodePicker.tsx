/**
 * VatCodePicker - the VAT codes that GL accounts, bank allocations and bank rules use. There is no VAT-code
 * endpoint and nothing to load, so this is a plain searchable Select over a static list: no debounce, no loading
 * state, no create row. The code type is `RuleVatCode` (bank.types.ts); the label map below is keyed by it, so a
 * code added there fails to compile here until it is given a label. The rate is `SA_VAT_RATE_PCT`.
 *
 * Do NOT use it for the items form: items store `'zero'` where every code here says `'zero_rated'`. It can serve
 * items once the two vocabularies are unified.
 */

import { Select, type SelectOption } from '../Select';
import type { RuleVatCode } from '@/modules/accounting/types/bank.types';
import { SA_VAT_RATE_PCT } from '@/modules/accounting/services/bank/bankVatInclusive';

const VAT_CODE_LABELS: Record<RuleVatCode, string> = {
  none: 'No VAT',
  standard: `Standard ${SA_VAT_RATE_PCT}%`,
  zero_rated: 'Zero Rated',
  exempt: 'Exempt',
};
const ALL_CODES = Object.keys(VAT_CODE_LABELS) as RuleVatCode[];

export interface VatCodePickerProps {
  label: string;
  value: RuleVatCode | null;
  onChange: (value: RuleVatCode | null, option: SelectOption | null) => void;
  /** Restrict to these codes (default: all four). */
  codes?: RuleVatCode[];
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  error?: string;
  className?: string;
  labelClassName?: string;
  id?: string;
}

export function VatCodePicker({ codes = ALL_CODES, onChange, placeholder = 'Select VAT code…', ...rest }: VatCodePickerProps) {
  const options: SelectOption[] = codes.map((c) => ({ value: c, label: VAT_CODE_LABELS[c] }));
  return (
    <Select
      {...rest}
      placeholder={placeholder}
      options={options}
      // the current value is named even when `codes` excludes it
      valueOption={rest.value ? { value: rest.value, label: VAT_CODE_LABELS[rest.value] } : null}
      searchable
      onChange={(v) => onChange(v as RuleVatCode | null, options.find((o) => o.value === v) ?? null)}
    />
  );
}
