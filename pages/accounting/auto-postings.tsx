/**
 * Auto-Postings Audit Trail
 *
 * Shows every journal entry that was created automatically by the system
 * (invoice approval, supplier bill approval, payroll run, bank allocation, etc.)
 * These entries are hidden from the regular Journal Entries page to keep
 * that view reserved for manual journals; this page exists for audit
 * and reconciliation.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { AlertCircle, FileSpreadsheet, Filter, Loader2, Shield } from 'lucide-react';

interface AutoEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string | null;
  source: string;
  sourceDocumentId: string | null;
  status: string;
  fiscalPeriodId: string | null;
  postedAt: string | null;
  lineCount: number;
  totalDebit: number;
  totalCredit: number;
}

interface AutoResponse {
  entries: AutoEntry[];
  total: number;
  breakdown: Record<string, number>;
}

const SOURCE_LABELS: Record<string, string> = {
  auto_invoice: 'Customer invoice',
  auto_payment: 'Customer payment',
  auto_supplier_invoice: 'Supplier bill',
  auto_supplier_payment: 'Supplier payment',
  auto_payroll: 'Payroll run',
  auto_bank_recon: 'Bank allocation',
  auto_credit_note: 'Credit note',
  auto_grn: 'Goods received',
  auto_write_off: 'Write-off',
  auto_adjustment: 'Adjustment',
  auto_vat_adjustment: 'VAT adjustment',
  auto_batch_payment: 'Batch payment',
  auto_recurring: 'Recurring',
  auto_purchase_order: 'Purchase order',
  auto_depreciation: 'Depreciation',
  auto_migration: 'Migration',
};

const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s;
const PAGE_SIZE = 100;

function fmtR(n: number) {
  if (!n) return '—';
  return 'R ' + n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function AutoPostingsPage() {
  const [data, setData] = useState<AutoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (sourceFilter) params.set('source', sourceFilter);
      if (fromDate) params.set('fromDate', fromDate);
      if (toDate) params.set('toDate', toDate);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));

      const res = await apiFetch(`/api/accounting/journal-entries-audit?${params.toString()}`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const json = await res.json();
      setData(json.data ?? json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load audit trail';
      setError(msg);
      log.error('Failed to load auto-postings', { error: err }, 'accounting-ui');
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, fromDate, toDate, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const sourceChips = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.breakdown).sort((a, b) => b[1] - a[1]);
  }, [data]);

  const documentHrefFor = (entry: AutoEntry): string | null => {
    if (!entry.sourceDocumentId) return null;
    switch (entry.source) {
      case 'auto_invoice':
      case 'auto_payment':
        return `/accounting/customer-invoices/${entry.sourceDocumentId}`;
      case 'auto_supplier_invoice':
      case 'auto_supplier_payment':
        return `/accounting/supplier-invoices/${entry.sourceDocumentId}`;
      case 'auto_payroll':
        return `/payroll/runs/${entry.sourceDocumentId}`;
      case 'auto_bank_recon':
        return `/accounting/bank-transactions?txId=${entry.sourceDocumentId}`;
      default:
        return null;
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Shield className="h-7 w-7 text-teal-500" />
              <div>
                <h1 className="text-xl font-bold">Auto-posting audit trail</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Every journal entry created automatically by invoices, bills, payroll, and bank allocations. Not shown in the Journal Entries list.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <div className="flex items-center gap-3 flex-wrap">
            <Filter className="h-4 w-4 text-[var(--ff-text-secondary)]" />
            <select
              value={sourceFilter}
              onChange={(e) => { setPage(0); setSourceFilter(e.target.value); }}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]"
            >
              <option value="">All sources</option>
              {sourceChips.map(([src, n]) => (
                <option key={src} value={src}>{sourceLabel(src)} ({n})</option>
              ))}
            </select>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => { setPage(0); setFromDate(e.target.value); }}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]"
            />
            <span className="text-sm text-[var(--ff-text-secondary)]">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => { setPage(0); setToDate(e.target.value); }}
              className="px-3 py-1.5 text-sm rounded-md border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]"
            />
            {(sourceFilter || fromDate || toDate) && (
              <button
                onClick={() => { setSourceFilter(''); setFromDate(''); setToDate(''); setPage(0); }}
                className="px-3 py-1.5 text-sm rounded-md border border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-secondary)]"
              >
                Clear
              </button>
            )}
            {data && (
              <div className="ml-auto text-sm text-[var(--ff-text-secondary)]">
                {data.total.toLocaleString()} system entries
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          )}

          {error && !loading && (
            <div className="flex items-start gap-2 p-4 rounded-md border border-red-500/30 bg-red-500/10 text-red-400">
              <AlertCircle className="h-5 w-5 mt-0.5" />
              <div>
                <p className="font-medium">Unable to load</p>
                <p className="text-sm">{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && data && data.entries.length === 0 && (
            <div className="text-center py-16 text-[var(--ff-text-secondary)]">
              <FileSpreadsheet className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>No automatic entries match these filters.</p>
            </div>
          )}

          {!loading && !error && data && data.entries.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--ff-bg-secondary)] text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Entry #</th>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Source</th>
                    <th className="px-4 py-3 font-medium">Description</th>
                    <th className="px-4 py-3 font-medium text-right">Lines</th>
                    <th className="px-4 py-3 font-medium text-right">Debit</th>
                    <th className="px-4 py-3 font-medium text-right">Credit</th>
                    <th className="px-4 py-3 font-medium">Source doc</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => {
                    const docHref = documentHrefFor(e);
                    const balanced = Math.abs(e.totalDebit - e.totalCredit) < 0.01;
                    return (
                      <tr key={e.id} className="border-t border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-secondary)]/50">
                        <td className="px-4 py-2 font-mono text-xs">
                          <Link href={`/accounting/journal-entries/${e.id}`} className="text-teal-500 hover:underline">
                            {e.entryNumber}
                          </Link>
                        </td>
                        <td className="px-4 py-2">{e.entryDate}</td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-teal-500/10 text-teal-400 border border-teal-500/20">
                            {sourceLabel(e.source)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-md truncate">
                          {e.description || '—'}
                        </td>
                        <td className="px-4 py-2 text-right">{e.lineCount}</td>
                        <td className="px-4 py-2 text-right font-mono">{fmtR(e.totalDebit)}</td>
                        <td className={`px-4 py-2 text-right font-mono ${balanced ? '' : 'text-red-400'}`}>
                          {fmtR(e.totalCredit)}{!balanced && ' ⚠'}
                        </td>
                        <td className="px-4 py-2">
                          {docHref ? (
                            <Link href={docHref} className="text-xs text-teal-500 hover:underline">
                              Open
                            </Link>
                          ) : (
                            <span className="text-xs text-[var(--ff-text-secondary)]">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {data && data.total > PAGE_SIZE && (
            <div className="mt-4 flex items-center justify-between text-sm">
              <div className="text-[var(--ff-text-secondary)]">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} of {data.total}
              </div>
              <div className="flex gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="px-3 py-1 rounded border border-[var(--ff-border-light)] disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="px-2 py-1">Page {page + 1} of {totalPages}</span>
                <button
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1 rounded border border-[var(--ff-border-light)] disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
