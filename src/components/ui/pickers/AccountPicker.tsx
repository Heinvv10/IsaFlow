/**
 * AccountPicker - GL accounts, optionally narrowed by type and/or subtype.
 * The chart route has no search parameter, so the chart is fetched once per open and typeahead filters it locally
 * (code or name); reopening refetches.
 */

import { useCallback, useRef } from 'react';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import { RemotePicker, type PickerProps } from './RemotePicker';
import { fetchAccountRows, type AccountRow } from './pickerData';
import type { FetchOptions } from './useRemoteOptions';

export interface AccountPickerProps extends PickerProps {
  accountType?: GLAccountType | GLAccountType[];
  accountSubtype?: string | string[];
}

const toArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function AccountPicker({ accountType, accountSubtype, placeholder, ...rest }: AccountPickerProps) {
  const chart = useRef<Promise<AccountRow[]> | null>(null);
  const types = toArray(accountType).join(',');
  const subtypes = toArray(accountSubtype).join(',');

  const fetchOptions = useCallback<FetchOptions>(async (query, signal, { initial }) => {
    if (initial || !chart.current) chart.current = fetchAccountRows(signal);
    const pending = chart.current;
    let all: AccountRow[];
    try {
      all = await pending;
    } catch (err) {
      if (chart.current === pending) chart.current = null; // never cache a failure
      throw err;
    }
    const q = query.trim().toLowerCase();
    return all
      .filter((a) => (types === '' || types.split(',').includes(a.accountType)) && (subtypes === '' || subtypes.split(',').includes(a.accountSubtype)))
      .filter((a) => q === '' || a.option.label.toLowerCase().includes(q))
      .map((a) => a.option);
  }, [types, subtypes]);

  return (
    <RemotePicker
      {...rest}
      placeholder={placeholder ?? 'Select account…'}
      createNoun="account"
      failureMessage="Could not load accounts - try again"
      fetchOptions={fetchOptions}
    />
  );
}
