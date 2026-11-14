/**
 * Record search for the admin host's Ctrl+K: companies and users, through the console's own list APIs
 * (GET /api/admin/companies and /api/admin/users, both behind withAdmin), five of each. No new search endpoint.
 *
 * Debounced; 2+ characters; a newer query aborts the older requests, and a late reply to an older query is dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useAdminPaletteSearch(isOpen: boolean, href: (path: string) => string): AdminPaletteSearch {
  const [query, setQuery] = useState('');
  const [reply, setReply] = useState<{ q: string; results: SearchResult[] }>({ q: '', results: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef('');

  // Cleared while CLOSED, so the next open starts empty on its first frame.
  if (!isOpen && query) setQuery('');

  const run = useCallback(async (q: string, signal: AbortSignal) => {
    setError('');
    try {
      const [companies, users] = await Promise.all([
        listOf<CompanyRow>('/api/admin/companies', q, signal),
        listOf<UserRow>('/api/admin/users', q, signal),
      ]);
      if (latest.current === q) setReply({ q, results: toResults(companies, users, href) });
    } catch (err) {
      if (signal.aborted || latest.current !== q) return;
      setReply({ q, results: [] });
      setError(apiErrorMessage(err, FAILED));
    } finally {
      if (latest.current === q) setLoading(false);
    }
  }, [href]);

  useEffect(() => {
    const q = query.trim();
    latest.current = q;
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
