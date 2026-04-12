/** Customer Communication Report */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Mail, Loader2, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface CommRecord {
  id: string;
  customerId: string | null;
  customerName: string;
  email: string;
  documentType: string;
  subject: string;
  sentAt: string;
  status: string;
}

interface ReportResponse {
  records: CommRecord[];
  total: number;
  page: number;
  limit: number;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'bounced', label: 'Bounced' },
];

const STATUS_COLOURS: Record<string, string> = {
  sent: 'text-teal-400 bg-teal-400/10',
  failed: 'text-red-400 bg-red-400/10',
  bounced: 'text-amber-400 bg-amber-400/10',
};

function statusBadge(status: string) {
  const cls = STATUS_COLOURS[status] ?? 'text-gray-400 bg-gray-400/10';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function fmtSentAt(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-ZA', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function docTypeLabel(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export default function CustomerCommunicationReport() {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString().split('T')[0]!;
  const todayStr = today.toISOString().split('T')[0]!;

  const [customerSearch, setCustomerSearch] = useState('');
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const limit = 50;

  const buildParams = useCallback((extraParams?: Record<string, string>) => {
    const p = new URLSearchParams();
    if (dateFrom) p.set('from', dateFrom);
    if (dateTo) p.set('to', dateTo);
    if (statusFilter) p.set('status', statusFilter);
    p.set('page', String(page));
    p.set('limit', String(limit));
    if (extraParams) {
      Object.entries(extraParams).forEach(([k, v]) => p.set(k, v));
    }
    return p;
  }, [dateFrom, dateTo, statusFilter, page]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(
        `/api/accounting/reports/customer-communication?${buildParams()}`,
        { credentials: 'include' }
      );
      const json = await res.json() as { data: ReportResponse };
      setData(json.data ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => { void load(); }, [load]);

  const handleExportCsv = useCallback(() => {
    const params = buildParams({ format: 'csv' });
    window.open(`/api/accounting/reports/customer-communication?${params}`, '_blank');
  }, [buildParams]);

  const filteredRecords = (data?.records ?? []).filter(r => {
    if (!customerSearch) return true;
    const q = customerSearch.toLowerCase();
    return (
      r.customerName.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q)
    );
  });

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Mail className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Customer Communication
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Emails sent to customers — invoices, statements, and notifications
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                placeholder="Search customer or email..."
                value={customerSearch}
                onChange={e => setCustomerSearch(e.target.value)}
                className="ff-input text-sm w-52"
              />
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
                className="ff-input text-sm"
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                type="date"
                value={dateFrom}
                onChange={e => { setDateFrom(e.target.value); setPage(1); }}
                className="ff-input text-sm"
              />
              <span className="text-[var(--ff-text-tertiary)] text-sm">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => { setDateTo(e.target.value); setPage(1); }}
                className="ff-input text-sm"
              />
              <button
                onClick={handleExportCsv}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--ff-text-tertiary)]" />
            </div>
          ) : !data || filteredRecords.length === 0 ? (
            <div className="text-center py-16 text-[var(--ff-text-tertiary)]">
              No communication records found for the selected filters.
            </div>
          ) : (
            <>
              <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Customer</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Email</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Document Type</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Subject</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase whitespace-nowrap">Sent At</th>
                      <th className="px-4 py-2 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {filteredRecords.map(rec => (
                      <tr
                        key={rec.id}
                        className="hover:bg-[var(--ff-bg-tertiary)] bg-[var(--ff-bg-primary)]"
                      >
                        <td className="px-4 py-2 font-medium text-[var(--ff-text-primary)] max-w-[160px] truncate">
                          {rec.customerName}
                        </td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-[180px] truncate">
                          {rec.email}
                        </td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] whitespace-nowrap">
                          {docTypeLabel(rec.documentType)}
                        </td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-xs truncate">
                          {rec.subject || '—'}
                        </td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] whitespace-nowrap text-xs">
                          {fmtSentAt(rec.sentAt)}
                        </td>
                        <td className="px-4 py-2 text-center">
                          {statusBadge(rec.status)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="mt-4 flex items-center justify-between text-xs text-[var(--ff-text-tertiary)]">
                <span>
                  Showing {filteredRecords.length} of {data.total} records
                </span>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="px-2 py-1 rounded border border-[var(--ff-border-light)] disabled:opacity-40 hover:bg-[var(--ff-bg-tertiary)]"
                    >
                      Prev
                    </button>
                    <span>Page {page} of {totalPages}</span>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="px-2 py-1 rounded border border-[var(--ff-border-light)] disabled:opacity-40 hover:bg-[var(--ff-bg-tertiary)]"
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
