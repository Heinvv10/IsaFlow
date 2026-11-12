/**
 * Loads a return's versions (and members' names for who took each step); reload after every action.
 * Everything returned belongs to the CURRENT period: data loaded for another period is never shown, not even for the
 * one render between a period change and its fetch. A failed reload of the same period keeps what was shown, with the
 * error beside it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { loadMemberNames, loadReturnVersions, type ReturnForm, type ReturnVersions } from './returnLifecycleClient';

export interface ReturnLifecycleState {
  data: ReturnVersions | null;
  loading: boolean;
  error: string;
  /** Display name for a user id; members who left show as "a former member". */
  nameOf: (userId: string) => string;
  reload: () => Promise<void>;
}

export function useReturnLifecycle(form: ReturnForm, periodStart: string, periodEnd: string): ReturnLifecycleState {
  const key = `${form}:${periodStart}:${periodEnd}`;
  const current = useRef(key);
  current.current = key;
  const [loaded, setLoaded] = useState<{ key: string; data: ReturnVersions } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string> | null>(null);

  const reload = useCallback(async () => {
    const k = `${form}:${periodStart}:${periodEnd}`;
    setPending(k); setFailed(null);
    try {
      const next = await loadReturnVersions(form, periodStart, periodEnd);
      if (current.current === k) setLoaded({ key: k, data: next });
    } catch (err) {
      if (current.current === k) setFailed({ key: k, message: apiErrorMessage(err, 'Could not load the return versions - try again') });
    } finally {
      setPending((p) => (p === k ? null : p));
    }
  }, [form, periodStart, periodEnd]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    let cancelled = false;
    loadMemberNames()
      .then((m) => { if (!cancelled) setNames(m); })
      // Names only label the steps; without them each step says the name could not be loaded.
      .catch(() => { if (!cancelled) setNames(new Map()); });
    return () => { cancelled = true; };
  }, []);

  const nameOf = useCallback((userId: string) => {
    if (names === null) return '…';
    return names.get(userId) ?? (names.size === 0 ? 'name not loaded' : 'a former member');
  }, [names]);

  const data = loaded?.key === key ? loaded.data : null;
  const error = failed?.key === key ? failed.message : '';
  return { data, loading: pending === key || (data === null && error === ''), error, nameOf, reload };
}
