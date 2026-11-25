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

/** What the form edits. The financial-year fields are derived by the server (re-read after a save), so they are not form state. */
export function formSnapshot(state: { company: object | null; docNumbers: unknown; messages: unknown; docDisplayFields: unknown }): string {
  const { financialYearStartActual: _a, financialYearStartLocked: _l, financialYearStartLockReason: _r, ...company } = (state.company ?? {}) as Record<string, unknown>;
  return settingsSnapshot({ ...state, company: state.company ? company : null });
}
