/**
 * Admin — Company List
 * Search, filter, sort, paginate, and bulk-act on companies.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { BulkActionsBar } from '@/components/admin/companies/BulkActionsBar';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import {
  Search, AlertCircle, Loader2, ChevronLeft, ChevronRight,
  ChevronsUpDown, Plus, UserCog, ShieldOff, ShieldCheck, X, Download,
} from 'lucide-react';

interface Company {
  id: string;
  name: string;
  trading_name: string | null;
  plan_name: string;
  plan_code: string;
  status: 'trial' | 'active' | 'suspended' | 'cancelled';
  user_count: number;
  mrr_cents: number;
  created_at: string;
  last_active: string | null;
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

type SortField = 'name' | 'plan_name' | 'status' | 'user_count' | 'mrr_cents' | 'created_at' | 'last_active';

interface CreateForm {
  name: string;
  trading_name: string;
  email: string;
  phone: string;
  plan_id: string;
}

export default function AdminCompaniesPage() {
  const adminHref = useAdminHref();

  const [rows, setRows]         = useState<Company[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [status, setStatus]     = useState('');
  const [sortBy, setSortBy]     = useState<SortField>('created_at');
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('desc');

  const [showCreate, setShowCreate]     = useState(false);
  const [createForm, setCreateForm]     = useState<CreateForm>({ name: '', trading_name: '', email: '', phone: '', plan_id: '' });
  const [creating, setCreating]         = useState(false);
  const [createError, setCreateError]   = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Bulk selection
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading]   = useState(false);

  const LIMIT = 25;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string, st: string, pg: number, sb: SortField, sd: string) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(LIMIT), sort_by: sb, sort_dir: sd });
      if (q)  params.set('search', q);
      if (st) params.set('status', st);
      const res  = await apiFetch(`/api/admin/companies?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message || 'Failed to load companies');
      const d = (json as { data: PagedResponse }).data;
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
      setSelectedIds(new Set());
      void load(search, status, 1, sortBy, sortDir);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, status, sortBy, sortDir, load]);

  useEffect(() => {
    setSelectedIds(new Set());
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

  // Header checkbox state
  const allSelected   = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
  const someSelected  = rows.some(r => selectedIds.has(r.id)) && !allSelected;

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(rows.map(r => r.id)));
    }
  }

  function toggleRow(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.name.trim()) { setCreateError('Name is required'); return; }
    setCreating(true); setCreateError('');
    try {
      const res  = await apiFetch('/api/admin/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify(createForm),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message || 'Failed to create company');
      setShowCreate(false);
      setCreateForm({ name: '', trading_name: '', email: '', phone: '', plan_id: '' });
      setPage(1);
      void load(search, status, 1, sortBy, sortDir);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setCreating(false);
    }
  }

  async function handleSuspend(e: React.MouseEvent, companyId: string) {
    e.stopPropagation();
    setActionLoading(companyId + ':suspend');
    try {
      await apiFetch(`/api/admin/companies/${companyId}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ reason: 'Suspended by admin' }),
      });
      void load(search, status, page, sortBy, sortDir);
    } catch { /* surfaced via row reload */ }
    finally { setActionLoading(null); }
  }

  async function handleActivate(e: React.MouseEvent, companyId: string) {
    e.stopPropagation();
    setActionLoading(companyId + ':activate');
    try {
      await apiFetch(`/api/admin/companies/${companyId}/activate`, { method: 'POST', headers: { 'X-Admin-Request': 'true' } });
      void load(search, status, page, sortBy, sortDir);
    } catch { /* surfaced via row reload */ }
    finally { setActionLoading(null); }
  }

  function handleImpersonate(e: React.MouseEvent, companyId: string) {
    e.stopPropagation();
    window.location.href = adminHref(`/admin/companies/${companyId}`);
  }

  // --- Bulk actions ---
  async function handleBulkSuspend() {
    setBulkLoading(true);
    try {
      const res  = await apiFetch('/api/admin/companies/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ action: 'suspend', company_ids: [...selectedIds], reason: 'Bulk suspended by admin' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message || 'Bulk suspend failed');
      setSelectedIds(new Set());
      void load(search, status, page, sortBy, sortDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk suspend failed');
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleBulkExtendTrial() {
    setBulkLoading(true);
    try {
      const res  = await apiFetch('/api/admin/companies/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ action: 'extend_trial', company_ids: [...selectedIds], days: 7 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message || 'Extend trial failed');
      setSelectedIds(new Set());
      void load(search, status, page, sortBy, sortDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extend trial failed');
    } finally {
      setBulkLoading(false);
    }
  }

  function handleExportCsv() {
    const selected = rows.filter(r => selectedIds.has(r.id));
    const header   = ['Name', 'Plan', 'Status', 'Users', 'MRR (ZAR)', 'Created'].join(',');
    const csvRows  = selected.map(r => [
      `"${r.name.replace(/"/g, '""')}"`,
      `"${(r.plan_name ?? '').replace(/"/g, '""')}"`,
      r.status,
      String(r.user_count),
      (r.mrr_cents / 100).toFixed(2),
      r.created_at.slice(0, 10),
    ].join(','));
    const blob = new Blob([[header, ...csvRows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `companies-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const colSpan = 10; // checkbox + 7 data cols + actions

  return (
    <AdminLayout title="Companies">
      {/* Filters */}
      <div className="flex gap-3 flex-wrap mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search companies..."
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
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center">{total} total</span>
        <a
          href={`/api/admin/companies/export${status ? `?status=${encodeURIComponent(status)}` : ''}`}
          download
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <Download className="w-4 h-4" /> Export CSV
        </a>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Company
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {selectedIds.size > 0 && (
        <BulkActionsBar
          count={selectedIds.size}
          loading={bulkLoading}
          onSuspend={() => void handleBulkSuspend()}
          onExtendTrial={() => void handleBulkExtendTrial()}
          onExportCsv={handleExportCsv}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300 dark:border-gray-600 text-teal-600 focus:ring-teal-500"
                    aria-label="Select all"
                  />
                </th>
                {([
                  ['name',        'Name'],
                  ['plan_name',   'Plan'],
                  ['status',      'Status'],
                  ['user_count',  'Users'],
                  ['mrr_cents',   'MRR'],
                  ['created_at',  'Created'],
                  ['last_active', 'Last Active'],
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
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-12 text-center">
                    <Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" />
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-12 text-center text-gray-600 dark:text-gray-400">No companies found</td>
                </tr>
              )}
              {rows.map(c => (
                <tr
                  key={c.id}
                  className={`border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer transition-colors ${selectedIds.has(c.id) ? 'bg-teal-50/50 dark:bg-teal-900/10' : ''}`}
                  onClick={() => { window.location.href = adminHref(`/admin/companies/${c.id}`); }}
                >
                  <td className="px-3 py-3 w-8" onClick={e => { e.stopPropagation(); toggleRow(c.id); }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleRow(c.id)}
                      className="rounded border-gray-300 dark:border-gray-600 text-teal-600 focus:ring-teal-500"
                      aria-label={`Select ${c.name}`}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.name}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.plan_name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[c.status] ?? ''}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{c.user_count}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{formatCurrency(c.mrr_cents / 100)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(c.created_at)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(c.last_active)}</td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <button
                        title="View / Impersonate"
                        onClick={e => handleImpersonate(e, c.id)}
                        disabled={actionLoading !== null}
                        className="p-1.5 rounded text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50"
                      >
                        <UserCog className="w-4 h-4" />
                      </button>
                      {c.status !== 'suspended'
                        ? <button
                            title="Suspend"
                            onClick={e => void handleSuspend(e, c.id)}
                            disabled={actionLoading !== null}
                            className="p-1.5 rounded text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === c.id + ':suspend'
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <ShieldOff className="w-4 h-4" />
                            }
                          </button>
                        : <button
                            title="Activate"
                            onClick={e => void handleActivate(e, c.id)}
                            disabled={actionLoading !== null}
                            className="p-1.5 rounded text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors disabled:opacity-50"
                          >
                            {actionLoading === c.id + ':activate'
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <ShieldCheck className="w-4 h-4" />
                            }
                          </button>
                      }
                    </div>
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

      {/* Create Company Modal */}
      {showCreate && (
        <div role="dialog" aria-modal="true" aria-labelledby="company-modal-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 id="company-modal-title" className="text-sm font-semibold text-gray-900 dark:text-white">Add Company</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={e => void handleCreate(e)} className="p-5 space-y-4">
              {createError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {createError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Company Name *</label>
                <input type="text" required value={createForm.name}
                  onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Trading Name</label>
                <input type="text" value={createForm.trading_name}
                  onChange={e => setCreateForm(f => ({ ...f, trading_name: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                  <input type="email" value={createForm.email}
                    onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Phone</label>
                  <input type="tel" value={createForm.phone}
                    onChange={e => setCreateForm(f => ({ ...f, phone: e.target.value }))}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={creating}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50">
                  {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Company
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
