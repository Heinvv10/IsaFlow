/**
 * AR Age Analysis Report Page
 * Shows outstanding customer invoices bucketed by days overdue.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Users, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatOverdueDays } from '@/lib/format/aging';

type Bucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

interface ARAgingRow {
  id: string;
  customer_name: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  days_overdue: number;
  bucket: Bucket;
}

interface BucketSummary {
  bucket: Bucket;
  count: number;
  total: number;
}

interface ARAgingData {
  rows: ARAgingRow[];
  summary: BucketSummary[];
  as_at_date: string;
}

const BUCKET_LABELS: Record<Bucket, string> = {
  current: 'Current',
  '1-30': '1–30 Days',
  '31-60': '31–60 Days',
  '61-90': '61–90 Days',
  '90+': '90+ Days',
};

const BUCKET_COLORS: Record<Bucket, string> = {
  current: 'text-teal-400',
  '1-30': 'text-yellow-400',
  '31-60': 'text-orange-400',
  '61-90': 'text-red-400',
  '90+': 'text-red-600',
};

const BUCKET_BG: Record<Bucket, string> = {
  current: 'bg-teal-500/10 border-teal-500/20',
  '1-30': 'bg-yellow-500/10 border-yellow-500/20',
  '31-60': 'bg-orange-500/10 border-orange-500/20',
  '61-90': 'bg-red-500/10 border-red-500/20',
  '90+': 'bg-red-700/10 border-red-700/20',
};

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtDate = (s: string) => {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
};

const BUCKETS: Bucket[] = ['current', '1-30', '31-60', '61-90', '90+'];

export default function ARAgingPage() {
  const [asAtDate, setAsAtDate] = useState(() => new Date().toISOString().split('T')[0] as string);
  const [data, setData] = useState<ARAgingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filterBucket, setFilterBucket] = useState<Bucket | 'all'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ as_at_date: asAtDate });
      const res = await apiFetch(`/api/accounting/reports-ar-aging?${params}`, { credentials: 'include' });
      const json = await res.json() as { data?: ARAgingData; message?: string };
      if (!res.ok) throw new Error(json.message ?? 'Failed to load AR aging');
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { void load(); }, [load]);

  function handleExport() {
    if (!data) return;
    const header = 'Customer,Invoice #,Invoice Date,Due Date,Total Amount,Amount Paid,Balance Due,Days Overdue,Bucket';
    const csvRows = displayRows.map(r =>
      [
        `"${r.customer_name.replace(/"/g, '""')}"`,
        `"${r.invoice_number}"`,
        fmtDate(r.invoice_date),
        fmtDate(r.due_date),
        r.total_amount.toFixed(2),
        r.amount_paid.toFixed(2),
        r.balance_due.toFixed(2),
        r.days_overdue,
        `"${BUCKET_LABELS[r.bucket]}"`,
      ].join(',')
    );
    const csv = [header, ...csvRows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ar-aging-${asAtDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const displayRows = data
    ? filterBucket === 'all'
      ? data.rows
      : data.rows.filter(r => r.bucket === filterBucket)
    : [];

  const grandTotal = data?.summary.reduce((s, b) => s + b.total, 0) ?? 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href="/accounting/reports"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">AR Age Analysis</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Outstanding customer invoices by age</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div>
                <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">As at date</label>
                <input
                  type="date"
                  value={asAtDate}
                  onChange={e => setAsAtDate(e.target.value)}
                  className="ff-input text-sm"
                />
              </div>
              <button
                onClick={handleExport}
                disabled={!data || data.rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50 mt-4"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-7xl space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : (
            <>
              {/* Bucket summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {BUCKETS.map(b => {
                  const s = data?.summary.find(x => x.bucket === b);
                  const isActive = filterBucket === b;
                  return (
                    <button
                      key={b}
                      onClick={() => setFilterBucket(isActive ? 'all' : b)}
                      className={`rounded-lg border p-4 text-left transition-all ${BUCKET_BG[b]} ${isActive ? 'ring-2 ring-offset-1 ring-[var(--ff-text-secondary)]' : 'hover:opacity-80'}`}
                    >
                      <p className="text-xs font-semibold text-[var(--ff-text-secondary)] mb-1">{BUCKET_LABELS[b]}</p>
                      <p className={`text-lg font-bold font-mono ${BUCKET_COLORS[b]}`}>
                        {fmt(s?.total ?? 0)}
                      </p>
                      <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
                        {s?.count ?? 0} invoice{(s?.count ?? 0) !== 1 ? 's' : ''}
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* Grand total bar */}
              {data && (
                <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)]">
                  <span className="text-sm font-semibold text-[var(--ff-text-secondary)]">
                    Total Outstanding{filterBucket !== 'all' ? ` — ${BUCKET_LABELS[filterBucket]}` : ''}
                  </span>
                  <span className="text-lg font-bold font-mono text-[var(--ff-text-primary)]">
                    {fmt(filterBucket === 'all' ? grandTotal : (data.summary.find(s => s.bucket === filterBucket)?.total ?? 0))}
                  </span>
                </div>
              )}

              {/* Detail table */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Invoice #</th>
                      <th className="px-4 py-3">Invoice Date</th>
                      <th className="px-4 py-3">Due Date</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Paid</th>
                      <th className="px-4 py-3 text-right">Balance Due</th>
                      <th className="px-4 py-3 text-right">Days Overdue</th>
                      <th className="px-4 py-3">Bucket</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">
                          No outstanding invoices{filterBucket !== 'all' ? ` in "${BUCKET_LABELS[filterBucket]}"` : ''}.
                        </td>
                      </tr>
                    ) : (
                      displayRows.map(r => (
                        <tr
                          key={r.id}
                          className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                        >
                          <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{r.customer_name}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)] font-mono text-xs">{r.invoice_number}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{fmtDate(r.invoice_date)}</td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{fmtDate(r.due_date)}</td>
                          <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)] font-mono">{fmt(r.total_amount)}</td>
                          <td className="px-4 py-3 text-right text-teal-400 font-mono">{fmt(r.amount_paid)}</td>
                          <td className="px-4 py-3 text-right font-mono font-semibold text-[var(--ff-text-primary)]">{fmt(r.balance_due)}</td>
                          <td className="px-4 py-3 text-right">
                            <span className={`font-semibold ${BUCKET_COLORS[r.bucket]}`}>
                              {r.days_overdue > 0 ? formatOverdueDays(r.days_overdue) : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${BUCKET_BG[r.bucket]} ${BUCKET_COLORS[r.bucket]}`}>
                              {BUCKET_LABELS[r.bucket]}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
