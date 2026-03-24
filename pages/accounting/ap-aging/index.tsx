/**
 * AP Aging Report Page
 * PRD-060 Phase 2: Current / 30 / 60 / 90 / 120+ day buckets
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { Clock, Loader2, AlertCircle, Download } from 'lucide-react';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

export default function APAgingPage() {
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
      const res = await fetch(`/api/accounting/ap-aging?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setBuckets(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load AP aging');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { loadAging(); }, [loadAging]);

  const totals = buckets.reduce(
    (acc, b) => ({
      current: acc.current + b.current,
      days30: acc.days30 + b.days30,
      days60: acc.days60 + b.days60,
      days90: acc.days90 + b.days90,
      days120Plus: acc.days120Plus + b.days120Plus,
      total: acc.total + b.total,
    }),
    { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 0 }
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Clock className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">AP Aging Report</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Outstanding supplier invoices by aging bucket
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-[var(--ff-text-secondary)]">As at:</label>
              <input
                type="date"
                value={asAtDate}
                onChange={e => setAsAtDate(e.target.value)}
                className="ff-input text-sm"
              />
              <button
                onClick={() => {
                  const params = new URLSearchParams();
                  if (asAtDate) params.set('as_at_date', asAtDate);
                  window.open(`/api/accounting/ap-aging-export?${params}`, '_blank');
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {[
              { label: 'Current', value: totals.current, color: 'text-emerald-500' },
              { label: '30 Days', value: totals.days30, color: 'text-amber-500' },
              { label: '60 Days', value: totals.days60, color: 'text-orange-500' },
              { label: '90 Days', value: totals.days90, color: 'text-red-400' },
              { label: '120+ Days', value: totals.days120Plus, color: 'text-red-600' },
              { label: 'Total', value: totals.total, color: 'text-[var(--ff-text-primary)]' },
            ].map(card => (
              <div key={card.label} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{card.label}</p>
                <p className={`text-lg font-bold font-mono mt-1 ${card.color}`}>{formatCurrency(card.value)}</p>
              </div>
            ))}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" />{error}
            </div>
          )}

          {/* Aging Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {isLoading ? (
              <div className="p-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : buckets.length === 0 ? (
              <div className="p-8 text-center">
                <Clock className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                <p className="text-[var(--ff-text-secondary)]">No outstanding supplier invoices</p>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Supplier</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-emerald-500 uppercase">Current</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-amber-500 uppercase">30 Days</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-orange-500 uppercase">60 Days</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-red-400 uppercase">90 Days</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-red-600 uppercase">120+ Days</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {buckets.map(b => (
                    <tr key={b.entityId} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
                        <Link href={`/accounting/supplier-statements/${b.entityId}`} className="hover:text-emerald-400 transition-colors">
                          {b.entityName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-emerald-500">{b.current > 0 ? formatCurrency(b.current) : '-'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-amber-500">{b.days30 > 0 ? formatCurrency(b.days30) : '-'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-orange-500">{b.days60 > 0 ? formatCurrency(b.days60) : '-'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-red-400">{b.days90 > 0 ? formatCurrency(b.days90) : '-'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-red-600">{b.days120Plus > 0 ? formatCurrency(b.days120Plus) : '-'}</td>
                      <td className="px-4 py-3 text-sm text-right font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(b.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)]">
                    <td className="px-4 py-3 text-sm font-bold text-[var(--ff-text-primary)]">TOTAL</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-emerald-500">{formatCurrency(totals.current)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-amber-500">{formatCurrency(totals.days30)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-orange-500">{formatCurrency(totals.days60)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-red-400">{formatCurrency(totals.days90)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-red-600">{formatCurrency(totals.days120Plus)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
