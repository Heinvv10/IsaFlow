/**
 * Server half of the command palette: the typed query, the debounced record search, and the recent list.
 * Pages and actions are matched on the client (paletteRank.ts), so only 2+ characters reach the server.
 *
 * Recents live in this browser, under a key per user AND company: a shared machine or a company switch must
 * not show another tenant's names. Employees are never stored there (personal data on the device).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { SearchResult } from './paletteRank';

/** Before recents were scoped this key held every user's and company's rows; it is deleted on sight. */
const LEGACY_RECENT_KEY = 'isaflow_recent_items';
const MAX_RECENT = 10;
export const MIN_SERVER_QUERY = 2;
const DEBOUNCE_MS = 300;
/** Never remembered: a person's name is personal data, and a recent list outlives the session. */
const NEVER_REMEMBERED = new Set(['employee']);

const recentKey = (scope: string): string => `${LEGACY_RECENT_KEY}:${scope}`;

const isText = (v: unknown): v is string => typeof v === 'string';

function isSearchResult(v: unknown): v is SearchResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return isText(r.type) && isText(r.id) && isText(r.title) && isText(r.url) && isText(r.icon)
    && (r.subtitle === undefined || isText(r.subtitle))
    && !NEVER_REMEMBERED.has(r.type);
}

export function loadRecentItems(scope: string | null): SearchResult[] {
  if (typeof window === 'undefined') return [];
  try {
    localStorage.removeItem(LEGACY_RECENT_KEY);
    if (!scope) return [];
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(scope)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(isSearchResult).map((r) => ({ ...r, subtitle: r.subtitle ?? '' }))
      : [];
  } catch {
    return [];
  }
}

export function saveRecentItem(scope: string | null, item: SearchResult): void {
  if (typeof window === 'undefined' || !scope || NEVER_REMEMBERED.has(item.type)) return;
  try {
    const existing = loadRecentItems(scope).filter(r => r.url !== item.url);
    localStorage.setItem(recentKey(scope), JSON.stringify([item, ...existing].slice(0, MAX_RECENT)));
  } catch {
    // Storage errors are non-fatal
  }
}

export interface PaletteSearch {
  query: string;
  setQuery: (q: string) => void;
  /** Records for the CURRENT query only; empty while a newer query is still in flight. */
  server: SearchResult[];
  loading: boolean;
  error: string;
  recent: SearchResult[];
}

/** `scope` is `${userId}:${companyId}`, or null until both are known. */
export function usePaletteSearch(isOpen: boolean, scope: string | null): PaletteSearch {
  const [query, setQuery] = useState('');
  const [reply, setReply] = useState<{ q: string; results: SearchResult[] }>({ q: '', results: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<SearchResult[]>([]);
  const latest = useRef('');

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setReply({ q: '', results: [] });
    setError('');
    setRecent(loadRecentItems(scope));
  }, [isOpen, scope]);

  const run = useCallback(async (q: string, signal: AbortSignal) => {
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/global-search?q=${encodeURIComponent(q)}&limit=12`, { signal });
      await assertOk(res, 'Could not search - try again');
      const data = await res.json() as { success: boolean; data: { results: SearchResult[] } };
      if (latest.current === q && data.success) setReply({ q, results: data.data.results });
    } catch (err) {
      if (signal.aborted || latest.current !== q) return;
      setReply({ q, results: [] });
      setError(apiErrorMessage(err, 'Could not search - try again'));
    } finally {
      if (latest.current === q) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    latest.current = q;
    if (!isOpen || q.length < MIN_SERVER_QUERY) {
      setReply({ q: '', results: [] });
      setError('');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const controller = new AbortController();
    const t = setTimeout(() => { void run(q, controller.signal); }, DEBOUNCE_MS);
    return () => { clearTimeout(t); controller.abort(); };
  }, [query, isOpen, run]);

  const server = reply.q === query.trim() ? reply.results : [];
  return { query, setQuery, server, loading, error, recent };
}
