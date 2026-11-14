/**
 * Record search for the admin host's Ctrl+K: companies and users, through the console's own list APIs
 * (GET /api/admin/companies and /api/admin/users, both behind withAdmin), five of each. No new search endpoint.
 *
 * Debounced; 2+ characters. Staleness has one mechanism, the AbortSignal: a newer query (or closing) aborts the
 * older run, and an aborted run never touches state, whatever stage it was at. Separately, `records` only ever shows
 * the reply to the query in the box, so the previous query's rows vanish while the new one is debounced or in flight.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '@/lib/admin/adminFetch';
import { apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { SearchResult } from '@/components/layout/paletteRank';

export const MIN_ADMIN_QUERY = 2;
const DEBOUNCE_MS = 300;
const PER_KIND = 5;
const FAILED = 'Could not search - try again';

interface CompanyRow { id: string; name: string; trading_name: string | null; status: string }
interface UserRow { id: string; first_name: string | null; last_name: string | null; email: string; role: string }
interface Paged<T> { items: T[] }

async function listOf<T>(path: string, q: string, signal: AbortSignal): Promise<T[]> {
  const res = await adminFetch(`${path}?search=${encodeURIComponent(q)}&limit=${PER_KIND}`, { signal });
  await assertOk(res, FAILED);
  const body = await res.json() as { data?: Paged<T> };
  return body.data?.items ?? [];
}

/** `href` turns an /admin/* path into this host's URL (useAdminHref). */
export function toResults(companies: CompanyRow[], users: UserRow[], href: (path: string) => string): SearchResult[] {
  return [
    ...companies.map((c): SearchResult => ({
      type: 'company', id: c.id, title: c.name, icon: 'building',
      subtitle: [c.trading_name && c.trading_name !== c.name ? c.trading_name : '', c.status].filter(Boolean).join(' · '),
      url: href(`/admin/companies/${encodeURIComponent(c.id)}`),
    })),
    ...users.map((u): SearchResult => {
      const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
      return {
        type: 'user', id: u.id, title: name || u.email, icon: 'user-round',
        subtitle: name ? u.email : u.role, url: href(`/admin/users/${encodeURIComponent(u.id)}`),
      };
    }),
  ];
}

export interface AdminPaletteSearch {
  query: string;
  setQuery: (q: string) => void;
  /** Records for the CURRENT query only. */
  records: SearchResult[];
  loading: boolean;
  error: string;
}

/** `initialQuery`: the starting text when the palette mounts already open (it was typed while the chunk loaded). */
export function useAdminPaletteSearch(isOpen: boolean, href: (path: string) => string, initialQuery = ''): AdminPaletteSearch {
  const [query, setQuery] = useState(initialQuery);
  const [reply, setReply] = useState<{ q: string; results: SearchResult[] }>({ q: '', results: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Cleared while CLOSED, so the next open starts empty on its first frame.
  if (!isOpen && query) setQuery('');

  const run = useCallback(async (q: string, signal: AbortSignal) => {
    setError('');
    try {
      const [companies, users] = await Promise.all([
        listOf<CompanyRow>('/api/admin/companies', q, signal),
        listOf<UserRow>('/api/admin/users', q, signal),
      ]);
      if (!signal.aborted) setReply({ q, results: toResults(companies, users, href) });
    } catch (err) {
      if (signal.aborted) return;
      setReply({ q, results: [] });
      setError(apiErrorMessage(err, FAILED));
    } finally {
      // An aborted run leaves the spinner to the run that replaced it (or to the reset below).
      if (!signal.aborted) setLoading(false);
    }
  }, [href]);

  useEffect(() => {
    const q = query.trim();
    if (!isOpen || q.length < MIN_ADMIN_QUERY) {
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

  const records = reply.q === query.trim() ? reply.results : [];
  return { query, setQuery, records, loading, error };
}
