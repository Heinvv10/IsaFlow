/**
 * Dirty tracking for Company Settings: the form is clean while its current
 * state serialises to the same text as the snapshot taken when it was last
 * loaded or saved. Keys are sorted so key order never makes a form dirty.
 */
import { useEffect, useState } from 'react';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function settingsSnapshot(state: unknown): string {
  return JSON.stringify(canonical(state));
}

/** `ready` is false while anything is loading; the snapshot taken once it turns true is the clean baseline. */
export function useSettingsDirty(snapshot: string, ready: boolean) {
  const [baseline, setBaseline] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) setBaseline(null);
    else if (baseline === null) setBaseline(snapshot);
  }, [ready, baseline, snapshot]);
  return { dirty: ready && baseline !== null && baseline !== snapshot, markClean: setBaseline };
}
