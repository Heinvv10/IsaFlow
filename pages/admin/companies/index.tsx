/**
 * Admin — Company List
 * Search, filter, sort, paginate, and bulk-act on companies.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { BulkActionsBar } from '@/components/admin/companies/BulkActionsBar';
import { downloadCompaniesSelectionCsv } from '@/components/admin/companies/companiesSelectionCsv';
import { adminExportHref } from '@/components/admin/adminExportHref';
import { BulkResultNotice, type BulkResult } from '@/components/admin/companies/BulkResultNotice';
import { CreateCompanyModal } from '@/components/admin/companies/CreateCompanyModal';
import { SuspendCompanyDialog } from '@/components/admin/companies/SuspendCompanyDialog';
import { assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { AdminPager } from '@/components/admin/AdminPager';
import { useRowSelection } from '@/components/admin/useRowSelection';
import { CompaniesTableHead } from '@/components/admin/companies/CompaniesTableHead';
import { CompanyListRow } from '@/components/admin/companies/CompanyListRow';
import type { Company, PagedResponse, SortField } from '@/components/admin/companies/companyListModel';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { Search, AlertCircle, Loader2, Plus, Download } from 'lucide-react';
import { adminFetch } from '@/lib/admin/adminFetch';


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
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Suspend waits for a confirm with a typed reason (audit 3.7); ids = one row or the bulk selection.
  const [suspendTarget, setSuspendTarget] = useState<{ ids: string[]; label: string; bulk: boolean } | null>(null);
  const [bulkResult, setBulkResult]       = useState<BulkResult | null>(null);
  // A failed suspend keeps the dialog (and the typed reason) open and says why there.
  const [suspendError, setSuspendError]   = useState('');
  const openSuspend = (t: { ids: string[]; label: string; bulk: boolean }) => { setSuspendError(''); setSuspendTarget(t); };

  // Bulk selection
  const { selectedIds, setSelectedIds, allSelected, someSelected, toggleSelectAll, toggleRow } = useRowSelection(rows);
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
      const res  = await adminFetch(`/api/admin/companies?${params}`);
      await assertOk(res, 'Could not load companies - try again');
      const json = await res.json();
      const d = (json as { data: PagedResponse }).data;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setRows([]); setTotal(0); setSelectedIds(new Set()); setError(apiErrorMessage(err, 'Could not load companies - try again'));
    } finally {
      setLoading(false);
    }
  }, [setSelectedIds]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      setSelectedIds(new Set());
      void load(search, status, 1, sortBy, sortDir);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, status, sortBy, sortDir, load, setSelectedIds]);

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

  // The row reload does NOT surface a rejected suspend/activate: apiFetch
  // resolves on 4xx, so without assertOk the row simply reloads unchanged and
  // the admin is left believing the action succeeded.
  async function handleSuspend(companyId: string, reason: string) {
    setActionLoading(companyId + ':suspend'); setError('');
    try {
      const res = await adminFetch(`/api/admin/companies/${companyId}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      await assertOk(res, 'Could not suspend the company - try again');
      setSuspendTarget(null);
      void load(search, status, page, sortBy, sortDir);
    } catch (err) { setSuspendError(apiErrorMessage(err, 'Could not suspend the company - try again')); }
    finally { setActionLoading(null); }
  }

  async function handleActivate(e: React.MouseEvent, companyId: string, action: 'activate' | 'restore') {
    e.stopPropagation();
    setActionLoading(companyId + ':activate'); setError('');
    try {
      const res = await adminFetch(`/api/admin/companies/${companyId}/${action}`, { method: 'POST' });
      await assertOk(res, `Could not ${action} the company - try again`);
      void load(search, status, page, sortBy, sortDir);
    } catch (err) { setError(apiErrorMessage(err, `Could not ${action} the company - try again`)); }
    finally { setActionLoading(null); }
  }

  function handleImpersonate(e: React.MouseEvent, companyId: string) {
    e.stopPropagation();
    window.location.href = adminHref(`/admin/companies/${companyId}`);
  }

  // --- Bulk actions --- (200 carries { processed, errors[] }: show both, audit 3.7)
  async function runBulk(label: string, body: Record<string, unknown>, failMsg: string) {
    setBulkLoading(true); setBulkResult(null);
    try {
      const res  = await adminFetch('/api/admin/companies/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await assertOk(res, failMsg);
      const d = ((await res.json()) as { data?: { processed?: number; errors?: string[] } }).data;
      setBulkResult({ label, processed: d?.processed ?? 0, errors: Array.isArray(d?.errors) ? d.errors : [] });
      setSelectedIds(new Set());
      setSuspendTarget(null);
      void load(search, status, page, sortBy, sortDir);
    } catch (err) {
      if (body.action === 'suspend') setSuspendError(apiErrorMessage(err, failMsg));
      else setError(apiErrorMessage(err, failMsg));
    } finally {
      setBulkLoading(false);
    }
  }

  function confirmSuspend(reason: string) {
    if (!suspendTarget) return;
    setSuspendError('');
    const [only] = suspendTarget.ids;
    if (!suspendTarget.bulk && only) { void handleSuspend(only, reason); return; }
    void runBulk('Suspend', { action: 'suspend', company_ids: suspendTarget.ids, reason }, 'Could not suspend the companies - try again');
  }

  function handleBulkExtendTrial() {
    void runBulk('Extend trial 7 days', { action: 'extend_trial', company_ids: [...selectedIds], days: 7 }, 'Could not extend the trial - try again');
  }

  function handleExportCsv() {
    downloadCompaniesSelectionCsv(rows.filter(r => selectedIds.has(r.id)));
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
          <option value="deleted">Deleted</option>
        </select>
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center">{total} total</span>
        <a
          href={adminExportHref('/api/admin/companies/export', { search, status, sort_by: sortBy, sort_dir: sortDir })}
          download
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          <Download className="w-4 h-4" /> Export CSV
        </a>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-700 text-white transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Company
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {bulkResult && (
        <BulkResultNotice result={bulkResult} names={Object.fromEntries(rows.map(r => [r.id, r.name]))} onDismiss={() => setBulkResult(null)} />
      )}

      {selectedIds.size > 0 && (
        <BulkActionsBar
          count={selectedIds.size}
          loading={bulkLoading}
          onSuspend={() => openSuspend({ ids: [...selectedIds], label: `${selectedIds.size} ${selectedIds.size === 1 ? 'company' : 'companies'}`, bulk: true })}
          onExtendTrial={handleBulkExtendTrial}
          onExportCsv={handleExportCsv}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <CompaniesTableHead
              allSelected={allSelected}
              someSelected={someSelected}
              toggleSelectAll={toggleSelectAll}
              sortBy={sortBy}
              toggleSort={toggleSort}
            />
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
                <CompanyListRow
                  key={c.id}
                  c={c}
                  selected={selectedIds.has(c.id)}
                  actionLoading={actionLoading}
                  onOpen={() => { window.location.href = adminHref(`/admin/companies/${c.id}`); }}
                  toggleRow={toggleRow}
                  handleImpersonate={handleImpersonate}
                  onSuspend={() => openSuspend({ ids: [c.id], label: c.name, bulk: false })}
                  handleActivate={handleActivate}
                />
              ))}
            </tbody>
          </table>
        </div>

        <AdminPager page={page} totalPages={totalPages} setPage={setPage} />
      </div>

      <CreateCompanyModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); setPage(1); void load(search, status, 1, sortBy, sortDir); }}
      />
      <SuspendCompanyDialog
        target={suspendTarget?.label ?? null}
        error={suspendError}
        loading={bulkLoading || actionLoading !== null}
        onConfirm={confirmSuspend}
        onCancel={() => setSuspendTarget(null)}
      />
    </AdminLayout>
  );
}
