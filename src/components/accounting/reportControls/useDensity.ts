/**
 * Owner / accountant reading density for the report surfaces.
 *
 * Same shape as `useDisplayMode`: localStorage answers the first paint, the
 * server preference is the source of truth across devices, and a change
 * writes both. Density changes what is SHOWN and never what a figure IS.
 *
 * ONE DELIBERATE DIVERGENCE from `useDisplayMode`: both requests go through
 * `assertOk`. `apiFetch` RESOLVES on 4xx and 5xx — it only intercepts 401 to
 * refresh — so a bare `.catch` on the save catches a dropped connection and
 * nothing else, and a rejected save looks exactly like a successful one. The
 * toggle would then show a density the server never stored, and the next
 * device would disagree with this one. `error` is what the page says out loud.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export type Density = 'owner' | 'accountant';

const LS_KEY = 'isaflow_reports_density';
const PREF_KEY = 'reports_density';

export const SAVE_FAILED =
  'Your reading density could not be saved, so it will not follow you to another device.';

const isDensity = (v: unknown): v is Density => v === 'owner' || v === 'accountant';

export function useDensity(): {
  density: Density;
  setDensity: (d: Density) => void;
  loading: boolean;
  error: string | null;
} {
  const [density, setState] = useState<Density>('owner');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (isDensity(stored)) {
      setState(stored);
      setLoading(false);
    }
    let cancelled = false;
    const sync = async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        await assertOk(res, 'Could not read saved preferences');
        const json = (await res.json()) as { data?: Record<string, string> };
        const server = json.data?.[PREF_KEY];
        if (isDensity(server) && !cancelled) {
          setState(server);
          localStorage.setItem(LS_KEY, server);
        }
      } catch (err) {
        // A failed READ is not worth a banner: the local value is already on
        // screen and is the same one this browser last chose. It is the failed
        // WRITE that leaves the user believing something untrue.
        log.warn('Failed to sync reports density preference', { error: err }, 'useDensity');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void sync();
    return () => { cancelled = true; };
  }, []);

  const setDensity = useCallback((next: Density) => {
    setState(next);
    setError(null);
    if (typeof window !== 'undefined') localStorage.setItem(LS_KEY, next);
    void (async () => {
      try {
        const res = await apiFetch('/api/auth/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferences: { [PREF_KEY]: next } }),
        });
        await assertOk(res, SAVE_FAILED);
      } catch (err) {
        log.warn('Failed to save reports density preference', { error: err }, 'useDensity');
        setError(SAVE_FAILED);
      }
    })();
  }, []);

  return { density, setDensity, loading, error };
}
