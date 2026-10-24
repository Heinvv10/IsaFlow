/**
 * AccountPicker - GL accounts, optionally narrowed by type and/or subtype.
 * The chart route has no search parameter, so the chart is fetched once per open and typeahead filters it locally
 * (code or name); reopening refetches.
 *
 * `value` is the account id, or the account CODE with valueKey="code" (ledger reports are keyed by code). When
 * `value` is set and no `valueLabel` is given, the chart is read once on mount to name it; if that read fails the
 * failure is shown under the field straight away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import { apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { RemotePicker, type PickerProps } from './RemotePicker';
import { fetchAccountRows, type AccountRow } from './pickerData';
import type { FetchOptions } from './useRemoteOptions';

export interface AccountPickerProps extends PickerProps {
  accountType?: GLAccountType | GLAccountType[];
  accountSubtype?: string | string[];
  /** What `value` / onChange carry: the account id (default) or its code. */
  valueKey?: 'id' | 'code';
  /** Narrow the chart after the type filters, e.g. to the postable accounts of a ledger report. */
  refine?: (rows: AccountRow[]) => AccountRow[];
}

const toArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const keyOf = (a: AccountRow, valueKey: 'id' | 'code') => (valueKey === 'code' ? a.accountCode : a.id);
const LOAD_FAILED = 'Could not load the chart of accounts - try again';

export function AccountPicker({ accountType, accountSubtype, valueKey = 'id', refine, placeholder, value, valueLabel, error, ...rest }: AccountPickerProps) {
  const chart = useRef<Promise<AccountRow[]> | null>(null);
  const refineRef = useRef(refine);
  useEffect(() => { refineRef.current = refine; });
  const types = toArray(accountType).join(',');
  const subtypes = toArray(accountSubtype).join(',');

  const load = useCallback((fresh: boolean): Promise<AccountRow[]> => {
    if (fresh || !chart.current) chart.current = fetchAccountRows();
    const pending = chart.current;
    pending.catch(() => { if (chart.current === pending) chart.current = null; }); // never cache a failure
    return pending;
  }, []);

  const fetchOptions = useCallback<FetchOptions>(async (query, _signal, { initial }) => {
    const all = await load(initial);
    const q = query.trim().toLowerCase();
    const narrowed = all.filter((a) =>
      (types === '' || types.split(',').includes(a.accountType)) && (subtypes === '' || subtypes.split(',').includes(a.accountSubtype)));
    return (refineRef.current ? refineRef.current(narrowed) : narrowed)
      .filter((a) => q === '' || a.option.label.toLowerCase().includes(q))
      .map((a) => ({ value: keyOf(a, valueKey), label: a.option.label }));
  }, [load, types, subtypes, valueKey]);

  const [named, setNamed] = useState<{ value: string; label: string } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  useEffect(() => {
    if (!value || valueLabel) return;
    let stale = false;
    load(false)
      .then((all) => {
        const hit = all.find((a) => keyOf(a, valueKey) === value);
        if (!stale) { setNamed(hit ? { value, label: hit.option.label } : null); setNameError(null); }
      })
      .catch((err: unknown) => {
        if (stale) return;
        log.warn('Account picker could not name the current value', { error: err instanceof Error ? err.message : String(err) }, 'ui-picker');
        setNameError(apiErrorMessage(err, LOAD_FAILED));
      });
    return () => { stale = true; };
  }, [value, valueLabel, valueKey, load]);

  return (
    <RemotePicker
      {...rest}
      value={value}
      valueLabel={valueLabel ?? (named?.value === value ? named.label : undefined)}
      error={error ?? nameError ?? undefined}
      placeholder={placeholder ?? 'Select account…'}
      createNoun="account"
      failureMessage={LOAD_FAILED}
      fetchOptions={fetchOptions}
    />
  );
}
