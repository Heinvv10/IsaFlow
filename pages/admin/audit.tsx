/**
 * Admin — Unified Audit Trail
 * All platform activity: admin actions, accounting transactions, user auth.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, ChevronLeft, ChevronRight, ScrollText, Download } from 'lucide-react';

interface UnifiedAuditEntry {
  id: string;
  source: 'admin' | 'accounting' | 'auth';
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  company_id: string | null;
  company_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_ref: string | null;
  details: string | Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

interface PagedResponse {
  items: UnifiedAuditEntry[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

interface DropdownItem { id: string; name: string; }

function getDefaultDates() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    from: start.toISOString().split('T')[0] as string,
    to:   now.toISOString().split('T')[0]   as string,
  };
}

const LIMIT = 50;

const SOURCE_LABELS: Record<string, string> = {
  admin: 'Admin',
  accounting: 'Accounting',
  auth: 'Auth',
};

const SOURCE_COLORS: Record<string, string> = {
  admin:      'bg-purple-500/15 text-purple-400',
  accounting: 'bg-teal-500/15 text-teal-400',
  auth:       'bg-blue-500/15 text-blue-400',
};

const ACTION_COLORS: Record<string, string> = {
  create:  'bg-green-500/15 text-green-400',
  update:  'bg-yellow-500/15 text-yellow-400',
  delete:  'bg-red-500/15 text-red-400',
  post:    'bg-teal-500/15 text-teal-400',
  reverse: 'bg-orange-500/15 text-orange-400',
  approve: 'bg-green-500/15 text-green-400',
  reject:  'bg-red-500/15 text-red-400',
  login:   'bg-blue-500/15 text-blue-400',
  export:  'bg-indigo-500/15 text-indigo-400',
};

function actionBadge(action: string) {
  const cls = ACTION_COLORS[action.toLowerCase()] ?? 'bg-gray-500/15 text-gray-400';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {action.replaceAll('_', ' ')}
    </span>
  );
}

function DetailsCell({ value }: { value: UnifiedAuditEntry['details'] }) {
  const [open, setOpen] = useState(false);
  if (!value) return <span className="text-gray-500">—</span>;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
  return (
    <span>
      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{open ? text : preview}</span>
      {text.length > 60 && (
        <button
          onClick={() => setOpen(o => !o)}
          className="ml-1 text-teal-500 text-xs hover:underline"
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </span>
  );
}

function exportCsv(rows: UnifiedAuditEntry[]) {
  const header = ['Date','Source','User','Email','Company','Action','Entity Type','Entity Ref','IP','Details'];
  const escape = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = rows.map(r => [
    r.created_at,
    r.source,
    r.user_name ?? '',
    r.user_email ?? '',
    r.company_name ?? '',
    r.action,
    r.entity_type ?? '',
    r.entity_ref ?? '',
    r.ip_address ?? '',
    typeof r.details === 'string' ? r.details : JSON.stringify(r.details ?? ''),
  ].map(escape).join(','));
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500';

export default function AdminAuditPage() {
  const defaults = getDefaultDates();

  const [rows,        setRows]        = useState<UnifiedAuditEntry[]>([]);
  const [total,       setTotal]       = useState(0);
  const [page,        setPage]        = useState(1);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [companies,   setCompanies]   = useState<DropdownItem[]>([]);

  const [dateFrom,    setDateFrom]    = useState(defaults.from);
  const [dateTo,      setDateTo]      = useState(defaults.to);
  const [source,      setSource]      = useState('');
  const [companyId,   setCompanyId]   = useState('');
  const [action,      setAction]      = useState('');
  const [entityType,  setEntityType]  = useState('');
  const [search,      setSearch]      = useState('');

  useEffect(() => {
    void apiFetch('/api/admin/companies?limit=200')
      .then(r => r.json())
      .then(j => {
        const items = (j?.data?.items ?? j?.data ?? []) as Array<{ id: string; name: string }>;
        setCompanies(items.map(c => ({ id: c.id, name: c.name })));
      });
  }, []);

  const load = useCallback(async (pg: number) => {
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams({ page: String(pg), limit: String(LIMIT) });
      if (dateFrom)   p.set('from_date',   dateFrom);
      if (dateTo)     p.set('to_date',     dateTo);
      if (source)     p.set('source',      source);
      if (companyId)  p.set('company_id',  companyId);
      if (action)     p.set('action',      action);
      if (entityType) p.set('entity_type', entityType);
      if (search)     p.set('search',      search);
      const res  = await apiFetch(`/api/admin/audit?${p}`);
      const json = await res.json();
      if (!res.ok) throw new Error((json as { message?: string }).message ?? 'Failed to load');
      const d = json.data as PagedResponse;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, source, companyId, action, entityType, search]);

  useEffect(() => { setPage(1); void load(1); }, [load]);
  useEffect(() => { void load(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function fmtDateTime(d: string) {
    return new Date(d).toLocaleString('en-ZA', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <AdminLayout title="Audit Trail">

      {/* Filters — row 1 */}
      <div className="flex gap-3 flex-wrap mb-3 items-end">
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Source</label>
          <select value={source} onChange={e => setSource(e.target.value)} className={inputCls}>
            <option value="">All Sources</option>
            <option value="admin">Admin Actions</option>
            <option value="accounting">Accounting</option>
            <option value="auth">User Auth</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Company</label>
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} className={inputCls}>
            <option value="">All Companies</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Action</label>
          <select value={action} onChange={e => setAction(e.target.value)} className={inputCls}>
            <option value="">All Actions</option>
            {['create','update','delete','post','reverse','approve','reject','login','export',
              'suspend','activate','reset_password','logout'].map(a => (
              <option key={a} value={a}>{a.replaceAll('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Entity Type</label>
          <select value={entityType} onChange={e => setEntityType(e.target.value)} className={inputCls}>
            <option value="">All Types</option>
            {['journal_entry','customer_invoice','supplier_invoice','customer','supplier',
              'bank_transaction','payment','credit_note','quote','purchase_order',
              'plan','subscription','announcement','feature_flag','settings','session',
              'company','user'].map(t => (
              <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Filters — row 2: search + count + export */}
      <div className="flex gap-3 flex-wrap mb-5 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Search</label>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Email, ref, or action…"
            className={`${inputCls} w-full`}
          />
        </div>
        <div className="flex items-end gap-3 ml-auto">
          <span className="text-sm text-gray-500 dark:text-gray-400 pb-2">{total.toLocaleString()} entries</span>
          <button
            onClick={() => exportCsv(rows)}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
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
                <th className="px-4 py-3 font-medium whitespace-nowrap">Date / Time</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Entity</th>
                <th className="px-4 py-3 font-medium">Details</th>
                <th className="px-4 py-3 font-medium">IP</th>
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
                  <td colSpan={8} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <ScrollText className="w-8 h-8 opacity-30" />
                      <span className="text-sm">No audit entries for selected filters</span>
                    </div>
                  </td>
                </tr>
              )}
              {rows.map(row => (
                <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 align-top">
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap font-mono text-xs">
                    {fmtDateTime(row.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${SOURCE_COLORS[row.source] ?? 'bg-gray-500/15 text-gray-400'}`}>
                      {SOURCE_LABELS[row.source] ?? row.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-gray-700 dark:text-gray-200 font-medium block">{row.user_name ?? '—'}</span>
                    {row.user_email && (
                      <span className="text-xs text-gray-400 block">{row.user_email}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 text-xs">
                    {row.company_name ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3">{actionBadge(row.action)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {row.entity_type && (
                      <span className="block text-xs capitalize">{row.entity_type.replaceAll('_', ' ')}</span>
                    )}
                    {row.entity_ref && (
                      <span className="block font-mono text-xs text-gray-400">{row.entity_ref}</span>
                    )}
                    {!row.entity_type && !row.entity_ref && <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <DetailsCell value={row.details} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs whitespace-nowrap">
                    {row.ip_address ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            Page {page} of {totalPages} &nbsp;·&nbsp; {total.toLocaleString()} total entries
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
