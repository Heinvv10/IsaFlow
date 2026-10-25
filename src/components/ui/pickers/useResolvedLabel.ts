/**
 * useResolvedLabel - names the picker's current `value` when the caller did not pass a `valueLabel` (an id from a
 * deep link, an OCR match or a saved record, which is rarely in the first page of options). One lookup per value;
 * a lookup that fails is reported at once under the field, not only when the dropdown is opened.
 *
 * `resolve` returns the label, or null when no such record exists (reported as `notFoundMessage` when given).
 */

import { useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export function useResolvedLabel(
  value: string | null,
  valueLabel: string | undefined,
  resolve: (value: string) => Promise<string | null>,
  failureMessage: string,
  notFoundMessage?: string,
): { label: string | undefined; error: string | undefined } {
  const [named, setNamed] = useState<{ value: string; label: string } | null>(null);
  const [error, setError] = useState<{ value: string; message: string } | null>(null);
  const resolveRef = useRef(resolve);
  useEffect(() => { resolveRef.current = resolve; });

  useEffect(() => {
    if (!value || valueLabel) return;
    let stale = false;
    resolveRef.current(value)
      .then((label) => {
        if (stale) return;
        setNamed(label ? { value, label } : null);
        setError(label || !notFoundMessage ? null : { value, message: notFoundMessage });
      })
      .catch((err: unknown) => {
        if (stale) return;
        log.warn('Picker could not name the current value', { error: err instanceof Error ? err.message : String(err) }, 'ui-picker');
        setError({ value, message: apiErrorMessage(err, failureMessage) });
      });
    return () => { stale = true; };
  }, [value, valueLabel, failureMessage, notFoundMessage]);

  return {
    label: valueLabel ?? (named && named.value === value ? named.label : undefined),
    error: error && error.value === value ? error.message : undefined,
  };
}
