/**
 * Admin — Company List
 * Search, filter, sort, paginate companies.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Search, AlertCircle, Loader2, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';

interface Company {
  id: string;
  name: string;
  plan: string;
  status: 'trial' | 'active' | 'suspended' | 'cancelled';
  userCount: number;
  mrrCents: number;
  createdAt: string;
  lastActiveAt: string | null;
}

interface PagedResponse {
  items: Company[];
  total: number;
  page: number;
  limit: number;
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  suspended: 'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
};

type SortField = 'name' | 'plan' | 'status' | 'userCount' | 'mrrCents' | 'createdAt' | 'lastActiveAt';

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-ZA');
}

export default function AdminCompaniesPage() {
  const router = useRouter();

  const [rows, setRows]         = useState<Company[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [status, setStatus]     = useState('');
  const [sortBy, setSortBy]     = useState<SortField>('createdAt');
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('desc');

  const LIMIT = 25;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string, st: string, pg: number, sb: SortField, sd: string) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        page:    String(pg),
        limit:   String(LIMIT),
        sortBy:  sb,
        sortDir: sd,
      });
      if (q)  params.set('search', q);
      if (st) params.set('status', st);
      const res  = await apiFetch(`/api/admin/companies?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load companies');
      const d = json.data as PagedResponse;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      void load(search, status, 1, sortBy, sortDir);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, status, sortBy, sortDir, load]);

  useEffect(() => {
    void load(search, status, page, sortBy, sortDir);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSort(field: SortField) {
    if (sortBy === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  function SortIcon({ field }: { field: SortField }) {
    if (sortBy !== field) return <ChevronsUpDown className="w-3.5 h-3.5 opacity-30" />;
    return <ChevronsUpDown className="w-3.5 h-3.5 text-teal-500" />;
  }

  return (
    <AdminLayout title="Companies">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search companies…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>
        <select
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">All statuses</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <span className="ml-auto text-sm text-gray-500 dark:text-gray-400 self-center">
          {total} total
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                {([
                  ['name',         'Name'],
                  ['plan',         'Plan'],
                  ['status',       'Status'],
                  ['userCount',    'Users'],
                  ['mrrCents',     'MRR'],
                  ['createdAt',    'Created'],
                  ['lastActiveAt', 'Last Active'],
                ] as [SortField, string][]).map(([field, label]) => (
                  <th
                    key={field}
                    className="px-4 py-3 font-medium cursor-pointer select-none hover:text-gray-900 dark:hover:text-white"
                    onClick={() => toggleSort(field)}
                  >
                    <div className="flex items-center gap-1">
                      {label} <SortIcon field={field} />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" />
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">No companies found</td>
                </tr>
              )}
              {rows.map(c => (
                <tr
                  key={c.id}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer transition-colors"
                  onClick={() => void router.push(`/admin/companies/${c.id}`)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.name}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.plan}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[c.status] ?? ''}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{c.userCount}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{fmtZAR(c.mrrCents)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(c.createdAt)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(c.lastActiveAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className="p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
