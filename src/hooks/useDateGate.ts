/**
 * Pairs with DateField on document forms. DateField hands the parent null for text it refused, and the
 * forms ignore that (`if (v.valid)`), so the state would keep the previous good date. `blocked` is true
 * while any bound field is showing a refusal, so submit can stop instead of posting that stale date.
 */
import { useCallback, useState } from 'react';
import type { FieldValidity } from '@/components/ui';

export interface DateGate {
  /** onChange for one DateField: remembers whether it is refused, and passes a valid ISO (or '') to `set`. */
  bind: (key: string, set: (iso: string) => void) => (iso: string | null, validity: FieldValidity) => void;
  /** True while any bound DateField shows a refused date. */
  blocked: boolean;
}

export function useDateGate(): DateGate {
  const [refused, setRefused] = useState<Record<string, boolean>>({});
  const bind = useCallback<DateGate['bind']>((key, set) => (iso, validity) => {
    setRefused((prev) => (prev[key] === !validity.valid ? prev : { ...prev, [key]: !validity.valid }));
    if (validity.valid) set(iso ?? '');
  }, []);
  return { bind, blocked: Object.values(refused).some(Boolean) };
}
