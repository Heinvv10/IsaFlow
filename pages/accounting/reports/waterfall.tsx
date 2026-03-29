/**
 * Waterfall Charts — Profit and Cash Flow waterfalls
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BarChart3, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { WaterfallChart } from '@/components/shared/WaterfallChart';
import type { WaterfallStep } from '@/modules/accounting/services/waterfallDataService';

type TabType = 'profit' | 'cashflow';

export default function WaterfallPage() {
  const [tab, setTab] = useState<TabType>('profit');
  const [steps, setSteps] = useState<WaterfallStep[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const now = new Date();
      const to = now.toISOString().split('T')[0];
      const fromDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const from = fromDate.toISOString().split('T')[0];
      const res = await apiFetch(`/api/accounting/reports-waterfall?type=${tab}&from=${from}&to=${to}`);
      const json = await res.json();
      if (json.data?.steps) setSteps(json.data.steps);
    } catch { /* empty state */ }
    finally { setLoading(false); }
  }, [tab]);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><BarChart3 className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Waterfall Charts</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Visualize profit breakdown and cash flow movement</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {/* Tab selector */}
          <div className="flex gap-1 bg-[var(--ff-bg-secondary)] rounded-lg p-1 w-fit border border-[var(--ff-border-light)]">
            {(['profit', 'cashflow'] as TabType[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  tab === t ? 'bg-teal-500 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}
              >
                {t === 'profit' ? 'Profit Waterfall' : 'Cash Flow Waterfall'}
              </button>
            ))}
          </div>

          {/* Chart */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">
              {tab === 'profit' ? 'Profit Waterfall — Revenue to Net Profit' : 'Cash Flow Waterfall — Opening to Closing'}
            </h2>
            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 text-teal-500 animate-spin" /></div>
            ) : steps.length > 0 ? (
              <WaterfallChart data={steps} height={400} />
            ) : (
              <p className="text-center text-[var(--ff-text-tertiary)] py-10">No data for selected period</p>
            )}
          </div>

          {/* Data table */}
          {steps.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-2 text-left text-xs text-[var(--ff-text-secondary)]">Item</th>
                    <th className="px-4 py-2 text-right text-xs text-[var(--ff-text-secondary)]">Amount</th>
                    <th className="px-4 py-2 text-center text-xs text-[var(--ff-text-secondary)]">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {steps.map((s, i) => (
                    <tr key={i} className={`border-b border-[var(--ff-border-light)] ${s.isSubtotal ? 'bg-[var(--ff-bg-tertiary)] font-semibold' : ''}`}>
                      <td className="px-4 py-2 text-sm text-[var(--ff-text-primary)]">{s.label}</td>
                      <td className={`px-4 py-2 text-sm text-right font-mono ${s.value >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                        R {Math.abs(s.value).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {s.isSubtotal && <span className="text-xs bg-teal-500/20 text-teal-400 px-2 py-0.5 rounded">Subtotal</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
