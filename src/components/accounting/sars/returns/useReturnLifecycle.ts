/** Loads a return's versions (and members' names for who took each step); reload after every action. */
import { useCallback, useEffect, useState } from 'react';
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
  const [data, setData] = useState<ReturnVersions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [names, setNames] = useState<Map<string, string> | null>(null);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setData(await loadReturnVersions(form, periodStart, periodEnd));
    } catch (err) {
      setData(null); setError(apiErrorMessage(err, 'Could not load the return versions - try again'));
    } finally {
      setLoading(false);
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

  return { data, loading, error, nameOf, reload };
}
