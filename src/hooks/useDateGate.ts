/**
 * Pairs with DateField on document forms. DateField hands the parent null for text it refused, and the
 * forms ignore that (`if (v.valid)`), so the state would keep the previous good date. `blocked` is true
 * while any bound field is showing a refusal, so submit can stop instead of posting that stale date.
 */
import { useCallback, useRef, useState } from 'react';
import type { FieldValidity } from '@/components/ui';

export interface DateGate {
  /**
   * onChange for one DateField: remembers whether it is refused, and passes a valid ISO (or '') to `set`.
   * Pass the field's current `value` as `current` so a refusal is dropped when the parent later sets a new date
   * (scan-fill, query param); without it the refusal lasts until the field reports a valid date.
   */
  bind: (key: string, set: (iso: string) => void, current?: string | null) => (iso: string | null, validity: FieldValidity) => void;
  /** Forget one field's refusal, for a field that unmounts or is no longer part of the form. */
  reset: (key: string) => void;
  /** True while any bound DateField shows a refused date. */
  blocked: boolean;
}

export function useDateGate(): DateGate {
  // key -> the parent's value when the field was refused
  const [refused, setRefused] = useState<Record<string, string | null | undefined>>({});
  const latest = useRef<Record<string, string | null | undefined>>({});
  const bind = useCallback<DateGate['bind']>((key, set, current) => {
    latest.current[key] = current;
    return (iso, validity) => {
      setRefused((prev) => {
        if (validity.valid) {
          if (!(key in prev)) return prev;
          const { [key]: _gone, ...rest } = prev;
          return rest;
        }
        return key in prev && prev[key] === latest.current[key] ? prev : { ...prev, [key]: latest.current[key] };
      });
      if (validity.valid) set(iso ?? '');
    };
  }, []);
  const reset = useCallback((key: string) => {
    setRefused((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);
  // A getter, so a submit handler reads the values the last render bound, not those of the render that made `dates`.
  return { bind, reset, get blocked() { return Object.entries(refused).some(([k, v]) => latest.current[k] === v); } };
}
