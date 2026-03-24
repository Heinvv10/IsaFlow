/**
 * Customer Age Analysis Page
 * Standalone view of AR aging with customer-focused branding
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { Users, Loader2, AlertCircle, Download } from 'lucide-react';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

export default function CustomerAgeAnalysisPage() {
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
      const res = await fetch(`/api/accounting/ar-aging?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setBuckets(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load customer aging');
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
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <Users className="h-6 w-6 text-blue-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Customer Age Analysis</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Customer outstanding balances by aging period
                  </p>
                </div>
              </div>
              <button onClick={handleExport} disabled={buckets.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
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

          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {[
              { label: 'Current', value: totals.current, color: 'emerald' },
              { label: '1-30 Days', value: totals.days30, color: 'amber' },
              { label: '31-60 Days', value: totals.days60, color: 'orange' },
              { label: '61-90 Days', value: totals.days90, color: 'red' },
              { label: '90+ Days', value: totals.days120Plus, color: 'purple' },
              { label: 'Total', value: totals.total, color: 'blue' },
            ].map(card => (
              <div key={card.label} className={`p-3 rounded-lg border border-[var(--ff-border-light)] bg-${card.color}-500/5`}>
                <p className="text-xs text-[var(--ff-text-tertiary)]">{card.label}</p>
                <p className={`text-lg font-bold text-${card.color}-400`}>{formatCurrency(card.value)}</p>
              </div>
            ))}
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
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
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Customer</th>
                    <th className="text-right px-4 py-3 text-emerald-400 font-medium">Current</th>
                    <th className="text-right px-4 py-3 text-amber-400 font-medium">1-30</th>
                    <th className="text-right px-4 py-3 text-orange-400 font-medium">31-60</th>
                    <th className="text-right px-4 py-3 text-red-400 font-medium">61-90</th>
                    <th className="text-right px-4 py-3 text-purple-400 font-medium">90+</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map(b => (
                    <tr key={b.entityId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] transition-colors">
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                        <Link href={`/accounting/customer-statements/${b.entityId}`} className="hover:text-blue-400 transition-colors">
                          {b.entityName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-400">{formatCurrency(b.current)}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-400">{formatCurrency(b.days30)}</td>
                      <td className="px-4 py-3 text-right font-mono text-orange-400">{formatCurrency(b.days60)}</td>
                      <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(b.days90)}</td>
                      <td className="px-4 py-3 text-right font-mono text-purple-400">{formatCurrency(b.days120Plus)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(b.total)}</td>
                    </tr>
                  ))}
                  {/* Totals row */}
                  <tr className="bg-[var(--ff-bg-primary)] font-bold">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-400">{formatCurrency(totals.current)}</td>
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
