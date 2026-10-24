/**
 * AccountPicker - GL accounts, optionally narrowed by type and/or subtype.
 * The chart route has no search parameter, so the chart is read whole and typeahead filters it locally (code or
 * name). Opening reuses a chart read less than 30 s ago (the route computes has-transactions per account) and
 * refetches otherwise; a failed read is never cached.
 *
 * `value` is the account id, or the account CODE with valueKey="code" (ledger reports are keyed by code). When
 * `value` is set and no `valueLabel` is given, the chart is read once on mount to name it; if that read fails the
 * failure is shown under the field straight away.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import { RemotePicker, type PickerProps } from './RemotePicker';
import { fetchAccountRows, type AccountRow } from './pickerData';
import { useResolvedLabel } from './useResolvedLabel';
import type { FetchOptions } from './useRemoteOptions';

export interface AccountPickerProps extends PickerProps {
  accountType?: GLAccountType | GLAccountType[];
  accountSubtype?: string | string[];
  /** What `value` / onChange carry: the account id (default) or its code. */
  valueKey?: 'id' | 'code';
  /** Narrow the whole chart BEFORE the type filters, e.g. to the postable accounts of a ledger report (it may need to see every account, parents included). */
  refine?: (rows: AccountRow[]) => AccountRow[];
}

const CHART_REUSE_MS = 30_000;
const toArray = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const keyOf = (a: AccountRow, valueKey: 'id' | 'code') => (valueKey === 'code' ? a.accountCode : a.id);
const LOAD_FAILED = 'Could not load the chart of accounts - try again';

export function AccountPicker({ accountType, accountSubtype, valueKey = 'id', refine, placeholder, value, valueLabel, error, ...rest }: AccountPickerProps) {
  const chart = useRef<{ rows: Promise<AccountRow[]>; at: number } | null>(null);
  const refineRef = useRef(refine);
  useEffect(() => { refineRef.current = refine; });
  const types = toArray(accountType).join(',');
  const subtypes = toArray(accountSubtype).join(',');

  const load = useCallback((fresh: boolean): Promise<AccountRow[]> => {
    const held = chart.current;
    if (held && !(fresh && Date.now() - held.at > CHART_REUSE_MS)) return held.rows;
    const rows = fetchAccountRows();
    const mine = { rows, at: Date.now() };
    chart.current = mine;
    rows.catch(() => { if (chart.current === mine) chart.current = null; }); // never cache a failure
    return rows;
  }, []);

  const fetchOptions = useCallback<FetchOptions>(async (query, _signal, { initial }) => {
    const all = await load(initial);
    const q = query.trim().toLowerCase();
    const scoped = refineRef.current ? refineRef.current(all) : all;
    const options = scoped
      .filter((a) => (types === '' || types.split(',').includes(a.accountType)) && (subtypes === '' || subtypes.split(',').includes(a.accountSubtype)))
      .filter((a) => q === '' || a.option.label.toLowerCase().includes(q))
      .map((a) => ({ value: keyOf(a, valueKey), label: a.option.label }));
    return { options };
  }, [load, types, subtypes, valueKey]);

  const resolve = useCallback(async (v: string) => (await load(false)).find((a) => keyOf(a, valueKey) === v)?.option.label ?? null, [load, valueKey]);
  const named = useResolvedLabel(value, valueLabel, resolve, LOAD_FAILED);

  return (
    <RemotePicker
      {...rest}
      value={value}
      valueLabel={named.label}
      error={error ?? named.error}
      placeholder={placeholder ?? 'Select account…'}
      createNoun="account"
      failureMessage={LOAD_FAILED}
      fetchOptions={fetchOptions}
    />
  );
}
