/**
 * useReportFavourites — manages starred reports per user via user_preferences.
 * Optimistic updates: toggle immediately, revert on API error.
 * WORKING: Loads once on mount, caches in state for the lifetime of the hook.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const PREF_KEY = 'report_favourites';

export interface UseReportFavouritesResult {
  favourites: string[];
  isFavourite: (id: string) => boolean;
  toggleFavourite: (id: string) => void;
  loading: boolean;
}

export function useReportFavourites(): UseReportFavouritesResult {
  const [favourites, setFavourites] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Track whether we have loaded at all to prevent double-fetch in StrictMode
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    void (async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        if (!res.ok) {
          log.warn('Failed to load preferences', { status: res.status }, 'useReportFavourites');
          return;
        }
        const json = (await res.json()) as { data?: Record<string, string> };
        const raw = json.data?.[PREF_KEY];
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (Array.isArray(parsed)) {
              setFavourites(parsed as string[]);
            }
          } catch {
            log.warn('Could not parse report_favourites pref', {}, 'useReportFavourites');
          }
        }
      } catch (err) {
        log.error('Error loading report favourites', { err }, 'useReportFavourites');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = useCallback(async (next: string[]) => {
    try {
      const res = await apiFetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { [PREF_KEY]: JSON.stringify(next) } }),
      });
      if (!res.ok) {
        log.warn('Failed to save report favourites', { status: res.status }, 'useReportFavourites');
        return false;
      }
      return true;
    } catch (err) {
      log.error('Error saving report favourites', { err }, 'useReportFavourites');
      return false;
    }
  }, []);

  const toggleFavourite = useCallback((id: string) => {
    setFavourites(prev => {
      const exists = prev.includes(id);
      const next = exists ? prev.filter(f => f !== id) : [...prev, id];

      // Optimistic: save in background, revert on failure
      void save(next).then(ok => {
        if (!ok) {
          setFavourites(prev2 => {
            // Revert: if we added, remove it; if we removed, add it back
            if (!exists) return prev2.filter(f => f !== id);
            if (!prev2.includes(id)) return [...prev2, id];
            return prev2;
          });
        }
      });

      return next;
    });
  }, [save]);

  const isFavourite = useCallback((id: string) => favourites.includes(id), [favourites]);

  return { favourites, isFavourite, toggleFavourite, loading };
}
