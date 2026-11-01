/**
 * Pairs with DateField on document forms. DateField hands the parent null for text it refused, and the
 * forms ignore that (`if (v.valid)`), so the state would keep the previous good date. `blocked` is true
 * while any bound field is showing a refusal, so submit can stop instead of posting that stale date.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FieldValidity } from '@/components/ui';

// useLayoutEffect warns when these forms render on the server, and nothing can be refused there.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface DateGate {
  /**
   * onChange for one DateField: remembers whether it is refused, and passes a valid ISO (or '') to `set`.
   * Pass the field's current `value` as `current` so a refusal is dropped when the parent later sets a new date
   * (scan-fill, query param); without it the refusal lasts until the field reports a valid date.
   */
  bind: (key: string, set: (iso: string) => void, current?: string | null) => (iso: string | null, validity: FieldValidity) => void;
  /**
   * Forget one field's refusal and bump its `resetKey`: for a field that unmounts or is no longer part of the form,
   * and for a scan-fill / form fill that sets a date the parent may ALREADY hold (a prop that did not change is not
   * news to DateField, so the refused text would stay on screen). Pass `resetKey(key)` to that DateField.
   */
  reset: (key: string) => void;
  /** The DateField `resetKey` for one field; changes each time `reset(key)` is called. */
  resetKey: (key: string) => number;
  /** True while any bound DateField shows a refused date. */
  blocked: boolean;
}

export function useDateGate(): DateGate {
  // key -> the parent's value when the field was refused
  const [refused, setRefused] = useState<Record<string, string | null | undefined>>({});
  const [resets, setResets] = useState<Record<string, number>>({});
  const latest = useRef<Record<string, string | null | undefined>>({});
  const newest = useRef(refused);
  newest.current = refused;
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
    setResets((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
    setRefused((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);
  const resetKey = useCallback((key: string) => resets[key] ?? 0, [resets]);
  // `bind` runs after a parent's render has read `blocked` (later in its JSX, or in a child like GatedDateField), so a new
  // date from the parent is only known once the render is done. Drop the refusal it replaced here, before anything paints.
  useBeforePaint(() => {
    const stillCurrent = ([k, v]: [string, string | null | undefined]): boolean => latest.current[k] === v;
    if (Object.entries(refused).every(stillCurrent)) return;
    setRefused((prev) => Object.fromEntries(Object.entries(prev).filter(stillCurrent)));
  });
  // A getter, so a submit handler holding an older `dates` reads the newest render's refusals, not those of the render that made it.
  return { bind, reset, resetKey, get blocked() { return Object.keys(newest.current).length > 0; } };
}
