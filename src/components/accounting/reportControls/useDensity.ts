/**
 * Owner / accountant reading density for the report surfaces.
 *
 * Same shape as `useDisplayMode`: localStorage answers the first paint, the
 * server preference is the source of truth across devices, and a change
 * writes both. Density changes what is SHOWN and never what a figure IS.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export type Density = 'owner' | 'accountant';

const LS_KEY = 'isaflow_reports_density';
const PREF_KEY = 'reports_density';

const isDensity = (v: unknown): v is Density => v === 'owner' || v === 'accountant';

export function useDensity(): { density: Density; setDensity: (d: Density) => void; loading: boolean } {
  const [density, setState] = useState<Density>('owner');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (isDensity(stored)) {
      setState(stored);
      setLoading(false);
    }
    const sync = async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        const json = (await res.json()) as { data?: Record<string, string> };
        const server = json.data?.[PREF_KEY];
        if (isDensity(server)) {
          setState(server);
          localStorage.setItem(LS_KEY, server);
        }
      } catch (err) {
        log.warn('Failed to sync reports density preference', { error: err }, 'useDensity');
      } finally {
        setLoading(false);
      }
    };
    void sync();
  }, []);

  const setDensity = useCallback((next: Density) => {
    setState(next);
    if (typeof window !== 'undefined') localStorage.setItem(LS_KEY, next);
    apiFetch('/api/auth/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { [PREF_KEY]: next } }),
    }).catch((err) => {
      log.warn('Failed to save reports density preference', { error: err }, 'useDensity');
    });
  }, []);

  return { density, setDensity, loading };
}
