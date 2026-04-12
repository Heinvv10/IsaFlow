/**
 * Admin — User List
 * Search, filter by role / status / company name, paginate.
 * Shows primary company with "+N more" badge when user has multiple companies.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatDate } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { Search, Building2, AlertCircle, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { UserDeleteCell } from '@/components/admin/UserDeleteCell';

interface AdminUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  status: 'active' | 'suspended' | 'inactive';
  company_count: number;
  primary_company: string | null;
  last_login: string | null;
  login_count: number;
  created_at: string;
}

interface PagedResponse {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  suspended: 'bg-red-500/10 text-red-500',
  inactive:  'bg-gray-500/10 text-gray-500',
};

const ROLES = ['super_admin', 'admin', 'manager', 'storeman', 'technician', 'viewer'];

const LIMIT = 25;

function CompanyCell({ primaryCompany, count }: { primaryCompany: string | null; count: number }) {
  if (!primaryCompany) {
    return <span className="text-gray-400 dark:text-gray-600 italic text-xs">None</span>;
  }
  const extra = count - 1;
  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      <span className="text-gray-700 dark:text-gray-300 truncate max-w-[160px]" title={primaryCompany}>
        {primaryCompany}
      </span>
      {extra > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 whitespace-nowrap">
          +{extra} more
        </span>
      )}
    </span>
  );
}

export default function AdminUsersPage() {
  const adminHref = useAdminHref();

  const [rows, setRows]             = useState<AdminUser[]>([]);
  const [total, setTotal]           = useState(0);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [search, setSearch]         = useState('');
  const [company, setCompany]       = useState('');
  const [role, setRole]             = useState('');
  const [status, setStatus]         = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting]     = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (
    q: string,
    co: string,
    r: string,
    st: string,
    pg: number,
  ) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(LIMIT) });
      if (q)  params.set('search', q);
      if (co) params.set('company', co);
      if (r)  params.set('role', r);
      if (st) params.set('status', st);
      const res  = await apiFetch(`/api/admin/users?${params}`);
      const json = await res.json() as { data?: PagedResponse; message?: string };
      if (!res.ok) throw new Error(json.message ?? 'Failed to load users');
      const d = json.data as PagedResponse;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      void load(search, company, role, status, 1);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, company, role, status, load]);

  useEffect(() => {
    void load(search, company, role, status, page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  const handleDelete = useCallback(async (userId: string) => {
    setDeleting(userId);
    setError('');
    try {
      const res = await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE', headers: { 'X-Admin-Request': 'true' } });
      if (!res.ok) {
        const json = await res.json() as { message?: string };
        throw new Error(json.message ?? 'Delete failed');
      }
      setConfirmDeleteId(null);
      void load(search, company, role, status, page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setDeleting(null);
    }
  }, [load, search, company, role, status, page]);

  return (
    <AdminLayout title="Users">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap mb-5">
        {/* Name / email search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search name or email..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>

        {/* Company name filter */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Filter by company..."
            value={company}
            onChange={e => setCompany(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </div>

        {/* Role select */}
        <select
          value={role}
          onChange={e => { setRole(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">All roles</option>
          {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>

        {/* Status select */}
        <select
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="inactive">Inactive</option>
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
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Last Login</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" />
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">No users found</td>
                </tr>
              )}
              {rows.map(u => (
                <tr
                  key={u.id}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer transition-colors"
                  onClick={() => { window.location.href = adminHref(`/admin/users/${u.id}`); }}
                >
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">
                    {u.first_name} {u.last_name}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{u.email}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{u.role}</td>
                  <td className="px-4 py-3">
                    <CompanyCell primaryCompany={u.primary_company} count={u.company_count} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {formatDate(u.last_login)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[u.status] ?? ''}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {formatDate(u.created_at)}
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {u.role !== 'super_admin' && (
                      <UserDeleteCell
                        confirming={confirmDeleteId === u.id}
                        working={deleting === u.id}
                        onRequest={() => setConfirmDeleteId(u.id)}
                        onConfirm={() => void handleDelete(u.id)}
                        onCancel={() => setConfirmDeleteId(null)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
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
