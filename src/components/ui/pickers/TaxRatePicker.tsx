/**
 * TaxRatePicker - the VAT codes accounts, bank allocations and rules already use ('none' | 'standard' |
 * 'zero_rated' | 'exempt'; see GLAccount.defaultVatCode). There is no VAT-code endpoint: the codes are a fixed
 * set in the code base and the only rate is the statutory one, so this list is static and cannot fail to load.
 */

import { useCallback } from 'react';
import { SA_VAT_RATE_PCT } from '@/modules/accounting/services/bank/bankVatInclusive';
import { RemotePicker, type PickerProps } from './RemotePicker';
import type { FetchOptions } from './useRemoteOptions';
import type { SelectOption } from '../Select';

export type VatCodeValue = 'none' | 'standard' | 'zero_rated' | 'exempt';

const VAT_CODE_OPTIONS: ReadonlyArray<SelectOption & { value: VatCodeValue }> = [
  { value: 'none', label: 'No VAT' },
  { value: 'standard', label: `Standard ${SA_VAT_RATE_PCT}%` },
  { value: 'zero_rated', label: 'Zero Rated' },
  { value: 'exempt', label: 'Exempt' },
];

export interface TaxRatePickerProps extends PickerProps {
  /** Restrict to these codes (default: all four). */
  codes?: VatCodeValue[];
}

export function TaxRatePicker({ codes, value, valueLabel, placeholder, ...rest }: TaxRatePickerProps) {
  const allowed = codes?.join(',');
  const fetchOptions = useCallback<FetchOptions>(async (query) => {
    const q = query.trim().toLowerCase();
    return VAT_CODE_OPTIONS
      .filter((o) => allowed === undefined || allowed.split(',').includes(o.value))
      .filter((o) => q === '' || o.label.toLowerCase().includes(q));
  }, [allowed]);

  return (
    <RemotePicker
      {...rest}
      value={value}
      valueLabel={valueLabel ?? VAT_CODE_OPTIONS.find((o) => o.value === value)?.label}
      placeholder={placeholder ?? 'Select VAT code…'}
      createNoun="tax rate"
      failureMessage="Could not load VAT codes - try again"
      fetchOptions={fetchOptions}
    />
  );
}
