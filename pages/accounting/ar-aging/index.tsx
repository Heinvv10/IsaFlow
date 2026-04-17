/**
 * AR Aging Report Page
 * PRD-060 Phase 3: Current / 30 / 60 / 90 / 120+ day buckets
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { Clock, Loader2, AlertCircle, Download } from 'lucide-react';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

export default function ARAgingPage() {
  const [buckets, setBuckets] = useState<AgingBucket[]>([]);
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadAging = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (asAtDate) params.set('as_at_date', asAtDate);
      const res = await apiFetch(`/api/accounting/ar-aging?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setBuckets(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load AR aging');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { loadAging(); }, [loadAging]);

  function handleExport() {
    const params = new URLSearchParams();
    if (asAtDate) params.set('as_at_date', asAtDate);
    window.location.href = `/api/accounting/ar-aging-export?${params}`;
  }

  const totals = buckets.reduce(
    (acc, b) => ({
      current: acc.current + (b.current || 0),
      days30: acc.days30 + (b.days30 || 0),
      days60: acc.days60 + (b.days60 || 0),
      days90: acc.days90 + (b.days90 || 0),
      days120Plus: acc.days120Plus + (b.days120Plus || 0),
      total: acc.total + (b.total || 0),
    }),
    { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 0 }
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <Clock className="h-6 w-6 text-teal-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">AR Aging Report</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Accounts Receivable by aging period
                  </p>
                </div>
              </div>
              <button onClick={handleExport} disabled={buckets.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Date Filter */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-[var(--ff-text-secondary)]">As at:</label>
            <input
              type="date"
              value={asAtDate}
              onChange={e => setAsAtDate(e.target.value)}
              className="ff-input text-sm"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {/* Summary Cards — traffic-light coloring (current → green, 90+ → deep red) */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {[
              { label: 'Current',    value: totals.current,     bg: 'bg-emerald-500/5', text: 'text-emerald-700 dark:text-emerald-400' },
              { label: '1-30 Days',  value: totals.days30,      bg: 'bg-amber-500/5',   text: 'text-amber-700 dark:text-amber-400' },
              { label: '31-60 Days', value: totals.days60,      bg: 'bg-orange-500/5',  text: 'text-orange-700 dark:text-orange-400' },
              { label: '61-90 Days', value: totals.days90,      bg: 'bg-red-500/5',     text: 'text-red-700 dark:text-red-400' },
              { label: '90+ Days',   value: totals.days120Plus, bg: 'bg-rose-500/10',   text: 'text-rose-700 dark:text-rose-400' },
              { label: 'Total',      value: totals.total,       bg: 'bg-slate-500/5',   text: 'text-slate-900 dark:text-slate-100' },
            ].map(card => (
              <div key={card.label} className={`p-3 rounded-lg border border-[var(--ff-border-light)] ${card.bg}`}>
                <p className="text-xs text-[var(--ff-text-tertiary)]">{card.label}</p>
                <p className={`text-lg font-bold ${card.text}`}>{formatCurrency(card.value)}</p>
              </div>
            ))}
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            </div>
          ) : buckets.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No outstanding receivables
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Client</th>
                    <th className="text-right px-4 py-3 text-emerald-700 dark:text-emerald-400 font-medium">Current</th>
                    <th className="text-right px-4 py-3 text-amber-700 dark:text-amber-400 font-medium">1-30</th>
                    <th className="text-right px-4 py-3 text-orange-700 dark:text-orange-400 font-medium">31-60</th>
                    <th className="text-right px-4 py-3 text-red-700 dark:text-red-400 font-medium">61-90</th>
                    <th className="text-right px-4 py-3 text-rose-700 dark:text-rose-400 font-medium">90+</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map(b => (
                    <tr key={b.entityId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors">
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                        <Link href={`/accounting/customer-statements/${b.entityId}`} className="hover:text-teal-400 transition-colors">
                          {b.entityName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-700 dark:text-emerald-400">{formatCurrency(b.current)}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-700 dark:text-amber-400">{formatCurrency(b.days30)}</td>
                      <td className="px-4 py-3 text-right font-mono text-orange-700 dark:text-orange-400">{formatCurrency(b.days60)}</td>
                      <td className="px-4 py-3 text-right font-mono text-red-700 dark:text-red-400">{formatCurrency(b.days90)}</td>
                      <td className="px-4 py-3 text-right font-mono text-rose-700 dark:text-rose-400">{formatCurrency(b.days120Plus)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(b.total)}</td>
                    </tr>
                  ))}
                  {/* Totals row */}
                  <tr className="bg-[var(--ff-bg-primary)] font-bold">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                    <td className="px-4 py-3 text-right font-mono text-teal-400">{formatCurrency(totals.current)}</td>
                    <td className="px-4 py-3 text-right font-mono text-amber-400">{formatCurrency(totals.days30)}</td>
                    <td className="px-4 py-3 text-right font-mono text-orange-400">{formatCurrency(totals.days60)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(totals.days90)}</td>
                    <td className="px-4 py-3 text-right font-mono text-purple-400">{formatCurrency(totals.days120Plus)}</td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(totals.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
