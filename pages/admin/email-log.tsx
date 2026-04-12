/**
 * Admin — Email Delivery Log
 * View all outbound email attempts, filter by status/type/date, retry failed.
 * Route: /admin/email-log
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, RefreshCw, Mail, AlertCircle, CheckCircle, Clock } from 'lucide-react';
import type { EmailLogItem, EmailLogStats } from '../api/admin/email-log';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtDate = (d: string) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
};

const EMAIL_TYPES = ['invoice', 'statement', 'quote', 'payment_receipt', 'invite', 'other'] as const;

const STATUS_COLORS: Record<string, string> = {
  sent:    'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  failed:  'bg-red-500/10 text-red-400 border border-red-500/30',
  bounced: 'bg-amber-500/10 text-amber-400 border border-amber-500/30',
};

const TYPE_LABELS: Record<string, string> = {
  invoice:         'Invoice',
  statement:       'Statement',
  quote:           'Quote',
  payment_receipt: 'Payment Receipt',
  invite:          'Invite',
  other:           'Other',
};

// ─── Stats Cards ──────────────────────────────────────────────────────────────

function StatsCards({ stats }: { stats: EmailLogStats }) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-teal-500/10">
          <CheckCircle className="h-5 w-5 text-teal-400" />
        </div>
        <div>
          <p className="text-xs text-gray-400">Total Sent (30d)</p>
          <p className="text-xl font-semibold text-white">{stats.total_sent.toLocaleString()}</p>
        </div>
      </div>
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-red-500/10">
          <AlertCircle className="h-5 w-5 text-red-400" />
        </div>
        <div>
          <p className="text-xs text-gray-400">Failed (30d)</p>
          <p className="text-xl font-semibold text-white">{stats.total_failed.toLocaleString()}</p>
        </div>
      </div>
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-blue-500/10">
          <Clock className="h-5 w-5 text-blue-400" />
        </div>
        <div>
          <p className="text-xs text-gray-400">Success Rate</p>
          <p className="text-xl font-semibold text-white">{stats.success_rate}%</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function EmailLogPage() {
  const [items, setItems]   = useState<EmailLogItem[]>([]);
  const [total, setTotal]   = useState(0);
  const [page, setPage]     = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [stats, setStats]   = useState<EmailLogStats>({ total_sent: 0, total_failed: 0, success_rate: 100 });

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter]     = useState('');
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');
  const [search, setSearch]             = useState('');
  const [expandedId, setExpandedId]     = useState<string | null>(null);

  const LIMIT = 25;

  const load = useCallback(async (p = page) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
      if (statusFilter) params.set('status', statusFilter);
      if (typeFilter)   params.set('email_type', typeFilter);
      if (dateFrom)     params.set('date_from', dateFrom);
      if (dateTo)       params.set('date_to', dateTo);
      if (search)       params.set('search', search);

      const res  = await apiFetch(`/api/admin/email-log?${params}`, { credentials: 'include' });
      const json = await res.json() as { data?: { items: EmailLogItem[]; total: number; stats: EmailLogStats } };
      const data = json.data;
      setItems(data?.items ?? []);
      setTotal(data?.total ?? 0);
      if (data?.stats) setStats(data.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load email log');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, typeFilter, dateFrom, dateTo, search]);

  useEffect(() => { void load(page); }, [load, page]);

  const handleFilter = () => { setPage(1); void load(1); };
  const handleClear  = () => {
    setStatusFilter(''); setTypeFilter('');
    setDateFrom(''); setDateTo(''); setSearch('');
    setPage(1);
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <AdminLayout title="Email Delivery Log">
      <div className="min-h-screen bg-gray-900">
        {/* Header */}
        <div className="border-b border-gray-700 bg-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Mail className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-white">Email Delivery Log</h1>
                <p className="text-sm text-gray-400">{total.toLocaleString()} records</p>
              </div>
            </div>
            <button
              onClick={() => void load(page)}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="p-6">
          <StatsCards stats={stats} />

          {/* Filter Bar */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Status</label>
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value)}
                  className="bg-gray-700 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5"
                >
                  <option value="">All</option>
                  <option value="sent">Sent</option>
                  <option value="failed">Failed</option>
                  <option value="bounced">Bounced</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Type</label>
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                  className="bg-gray-700 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5"
                >
                  <option value="">All Types</option>
                  {EMAIL_TYPES.map(t => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="bg-gray-700 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="bg-gray-700 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5"
                />
              </div>
              <div className="flex-1 min-w-40">
                <label className="block text-xs text-gray-400 mb-1">Recipient</label>
                <input
                  type="text"
                  placeholder="Search email…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleFilter()}
                  className="w-full bg-gray-700 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5 placeholder-gray-500"
                />
              </div>
              <button
                onClick={handleFilter}
                className="px-4 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors"
              >
                Apply
              </button>
              <button
                onClick={handleClear}
                className="px-4 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-600 rounded-lg transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            {error && (
              <div className="flex items-center gap-2 p-4 text-red-400 text-sm border-b border-gray-700">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {error}
              </div>
            )}
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-teal-400" />
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <Mail className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>No email records found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Sent At</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Company</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Recipient</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Subject</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Type</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {items.map(item => {
                      const isFailed  = item.status === 'failed';
                      const isExpanded = expandedId === item.id;
                      return (
                        <>
                          <tr
                            key={item.id}
                            className={`transition-colors cursor-pointer ${
                              isFailed
                                ? 'bg-red-900/10 hover:bg-red-900/20'
                                : 'hover:bg-gray-700/30'
                            }`}
                            onClick={() => setExpandedId(isExpanded ? null : item.id)}
                          >
                            <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                              {fmtDate(item.sent_at)}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-300 max-w-[140px] truncate">
                              {item.company_name ?? <span className="italic text-gray-500">—</span>}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-300 max-w-[180px] truncate">
                              {item.recipient_email}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-300 max-w-[220px] truncate">
                              {item.subject}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-400">
                              {TYPE_LABELS[item.email_type] ?? item.email_type}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-block px-2 py-0.5 text-xs rounded-full capitalize ${STATUS_COLORS[item.status] ?? ''}`}>
                                {item.status}
                              </span>
                            </td>
                          </tr>
                          {isExpanded && item.error_message && (
                            <tr key={`${item.id}-err`} className="bg-red-900/10">
                              <td colSpan={6} className="px-6 py-2">
                                <p className="text-xs text-red-400 font-mono break-all">
                                  Error: {item.error_message}
                                </p>
                              </td>
                            </tr>
                          )}
                          {isExpanded && !item.error_message && (
                            <tr key={`${item.id}-detail`} className="bg-gray-700/20">
                              <td colSpan={6} className="px-6 py-2">
                                <p className="text-xs text-gray-400">
                                  ID: <span className="font-mono text-gray-300">{item.id}</span>
                                  {item.sent_by && (
                                    <> · Sent by: <span className="font-mono text-gray-300">{item.sent_by}</span></>
                                  )}
                                </p>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
                <p className="text-xs text-gray-400">
                  Page {page} of {totalPages} · {total.toLocaleString()} records
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1.5 text-xs border border-gray-600 text-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="px-3 py-1.5 text-xs border border-gray-600 text-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
