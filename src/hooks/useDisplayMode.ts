/**
 * useDisplayMode — Debit/Credit display preference.
 * WS-6.4: Debit/Credit Display Toggle
 *
 * - 'split': show separate Debit and Credit columns
 * - 'net':   show a single Net Amount column (positive = debit, negative = credit)
 *
 * Loads instantly from localStorage, then syncs with the server preference API.
 * Saves to both localStorage and the server on change.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export type DisplayMode = 'split' | 'net';

const LS_KEY = 'isaflow_display_mode';
const PREF_KEY = 'display_mode_debit_credit';

export function useDisplayMode(): {
  displayMode: DisplayMode;
  setDisplayMode: (mode: DisplayMode) => void;
  loading: boolean;
} {
  const [displayMode, setDisplayModeState] = useState<DisplayMode>('split');
  const [loading, setLoading] = useState(true);

  // Load from localStorage first (instant), then sync from API
  useEffect(() => {
    const stored = typeof window !== 'undefined'
      ? (localStorage.getItem(LS_KEY) as DisplayMode | null)
      : null;

    if (stored === 'split' || stored === 'net') {
      setDisplayModeState(stored);
      setLoading(false);
    }

    // Sync from server
    const sync = async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        const json = await res.json() as { data?: Record<string, string> };
        const serverMode = json.data?.[PREF_KEY] as DisplayMode | undefined;
        if (serverMode === 'split' || serverMode === 'net') {
          setDisplayModeState(serverMode);
          localStorage.setItem(LS_KEY, serverMode);
        }
      } catch (err) {
        log.warn('Failed to sync display mode preference', { error: err }, 'useDisplayMode');
      } finally {
        setLoading(false);
      }
    };

    void sync();
  }, []);

  const setDisplayMode = useCallback((mode: DisplayMode) => {
    setDisplayModeState(mode);

    if (typeof window !== 'undefined') {
      localStorage.setItem(LS_KEY, mode);
    }

    // Persist to server (fire and forget)
    apiFetch('/api/auth/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { [PREF_KEY]: mode } }),
    }).catch(err => {
      log.warn('Failed to save display mode preference', { error: err }, 'useDisplayMode');
    });
  }, []);

  return { displayMode, setDisplayMode, loading };
}
