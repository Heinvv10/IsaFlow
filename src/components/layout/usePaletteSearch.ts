/**
 * Server half of the command palette: the typed query, the debounced record search, and the recent list.
 * Pages and actions are matched on the client (paletteRank.ts), so only 2+ characters reach the server.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { SearchResult } from './paletteRank';

const RECENT_KEY = 'isaflow_recent_items';
const MAX_RECENT = 10;
export const MIN_SERVER_QUERY = 2;
const DEBOUNCE_MS = 300;

export function loadRecentItems(): SearchResult[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as SearchResult[]) : [];
  } catch {
    return [];
  }
}

export function saveRecentItem(item: SearchResult): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = loadRecentItems().filter(r => r.url !== item.url);
    localStorage.setItem(RECENT_KEY, JSON.stringify([item, ...existing].slice(0, MAX_RECENT)));
  } catch {
    // Storage errors are non-fatal
  }
}

export interface PaletteSearch {
  query: string;
  setQuery: (q: string) => void;
  server: SearchResult[];
  loading: boolean;
  error: string;
  recent: SearchResult[];
}

export function usePaletteSearch(isOpen: boolean): PaletteSearch {
  const [query, setQuery] = useState('');
  const [server, setServer] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<SearchResult[]>([]);
  const latest = useRef('');

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setServer([]);
    setError('');
    setRecent(loadRecentItems());
  }, [isOpen]);

  const run = useCallback(async (q: string) => {
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/global-search?q=${encodeURIComponent(q)}&limit=12`);
      await assertOk(res, 'Could not search - try again');
      const data = await res.json() as { success: boolean; data: { results: SearchResult[] } };
      if (latest.current === q && data.success) setServer(data.data.results);
    } catch (err) {
      if (latest.current !== q) return;
      setServer([]);
      setError(apiErrorMessage(err, 'Could not search - try again'));
    } finally {
      if (latest.current === q) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    latest.current = q;
    if (q.length < MIN_SERVER_QUERY) {
      setServer([]);
      setError('');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const t = setTimeout(() => { void run(q); }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, run]);

  return { query, setQuery, server, loading, error, recent };
}
