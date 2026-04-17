/** Journal Entries Report — Sage Parity */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { BookOpen, Loader2, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface JournalEntryRow {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  source: string;
  status: string;
  totalDebits: number;
  totalCredits: number;
}

interface ReportResponse {
  entries: JournalEntryRow[];
  total: number;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'posted', label: 'Posted' },
  { value: 'reversed', label: 'Reversed' },
];

const SOURCE_OPTIONS = [
  { value: '', label: 'All Sources' },
  { value: 'manual', label: 'Manual' },
  { value: 'auto_invoice', label: 'Auto — Invoice' },
  { value: 'auto_payment', label: 'Auto — Payment' },
  { value: 'auto_credit_note', label: 'Auto — Credit Note' },
  { value: 'auto_bank_recon', label: 'Auto — Bank Recon' },
  { value: 'auto_supplier_invoice', label: 'Auto — Supplier Invoice' },
  { value: 'auto_supplier_payment', label: 'Auto — Supplier Payment' },
  { value: 'auto_grn', label: 'Auto — GRN' },
  { value: 'auto_write_off', label: 'Auto — Write Off' },
  { value: 'auto_adjustment', label: 'Auto — Adjustment' },
  { value: 'auto_vat_adjustment', label: 'Auto — VAT Adjustment' },
  { value: 'auto_batch_payment', label: 'Auto — Batch Payment' },
  { value: 'auto_recurring', label: 'Auto — Recurring' },
  { value: 'auto_purchase_order', label: 'Auto — Purchase Order' },
  { value: 'auto_depreciation', label: 'Auto — Depreciation' },
  { value: 'auto_payroll', label: 'Auto — Payroll' },
  { value: 'auto_migration', label: 'Auto — Migration' },
];

const STATUS_COLOURS: Record<string, string> = {
  draft: 'text-gray-400 bg-gray-400/10',
  posted: 'text-teal-400 bg-teal-400/10',
  reversed: 'text-amber-400 bg-amber-400/10',
};

function statusBadge(status: string) {
  const cls = STATUS_COLOURS[status] ?? 'text-gray-400 bg-gray-400/10';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function sourceLabel(source: string): string {
  const opt = SOURCE_OPTIONS.find(o => o.value === source);
  return opt ? opt.label : source;
}

function buildCsv(entries: JournalEntryRow[]): string {
  const header = ['Entry #', 'Date', 'Description', 'Source', 'Status', 'Total Debits', 'Total Credits'].join(',');
  const rows = entries.map(e => [
    `"${e.entryNumber}"`,
    e.entryDate,
    `"${(e.description ?? '').replace(/"/g, '""')}"`,
    `"${sourceLabel(e.source)}"`,
    e.status,
    e.totalDebits.toFixed(2),
    e.totalCredits.toFixed(2),
  ].join(','));
  return [header, ...rows].join('\n');
}

function downloadCsv(entries: JournalEntryRow[]) {
  const csv = buildCsv(entries);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `journal-entries-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function JournalEntriesReport() {
  const router = useRouter();
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]!;
  const todayStr = today.toISOString().split('T')[0]!;

  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (source) params.set('source', source);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      params.set('limit', '500');
      const res = await apiFetch(`/api/accounting/reports-journal-entries?${params}`, {
        credentials: 'include',
      });
      const json = await res.json() as { data: ReportResponse };
      setData(json.data ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [status, source, dateFrom, dateTo]);

  useEffect(() => { void load(); }, [load]);

  const totalDebits = data?.entries.reduce((s, e) => s + e.totalDebits, 0) ?? 0;
  const totalCredits = data?.entries.reduce((s, e) => s + e.totalCredits, 0) ?? 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <BookOpen className="h-6 w-6 text-indigo-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Journal Entries</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">All GL journal entries with debit / credit totals</p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="ff-input text-sm"
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <select
                value={source}
                onChange={e => setSource(e.target.value)}
                className="ff-input text-sm"
              >
                {SOURCE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="ff-input text-sm"
              />
              <span className="text-[var(--ff-text-tertiary)] text-sm">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="ff-input text-sm"
              />
              <button
                onClick={() => data && downloadCsv(data.entries)}
                disabled={!data || data.entries.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg transition-colors"
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
          ) : !data || data.entries.length === 0 ? (
            <div className="text-center py-16 text-[var(--ff-text-tertiary)]">
              No journal entries found for the selected filters.
            </div>
          ) : (
            <>
              <div className="border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Entry #</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Description</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Source</th>
                      <th className="px-4 py-2 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total Debits</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total Credits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {data.entries.map(entry => (
                      <tr
                        key={entry.id}
                        onClick={() => void router.push(`/accounting/journal-entries/${entry.id}`)}
                        className="hover:bg-[var(--ff-bg-tertiary)] bg-[var(--ff-bg-primary)] cursor-pointer"
                      >
                        <td className="px-4 py-2 font-mono text-xs text-[var(--ff-text-primary)]">{entry.entryNumber}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] whitespace-nowrap">{entry.entryDate}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-xs truncate">{entry.description || '—'}</td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{sourceLabel(entry.source)}</td>
                        <td className="px-4 py-2 text-center">{statusBadge(entry.status)}</td>
                        <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(entry.totalDebits)}</td>
                        <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(entry.totalCredits)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-secondary)]">
                      <td colSpan={5} className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                        Totals ({data.entries.length} {data.entries.length === 1 ? 'entry' : 'entries'})
                      </td>
                      <td className="px-4 py-2 text-right font-mono font-bold text-[var(--ff-text-primary)]">{fmt(totalDebits)}</td>
                      <td className="px-4 py-2 text-right font-mono font-bold text-[var(--ff-text-primary)]">{fmt(totalCredits)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {data.total > data.entries.length && (
                <p className="mt-3 text-center text-xs text-[var(--ff-text-tertiary)]">
                  Showing {data.entries.length} of {data.total} entries. Narrow date range or filters to see all.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
