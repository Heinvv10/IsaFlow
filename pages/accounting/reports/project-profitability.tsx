/**
 * Project Profitability Report Page
 * PRD-060 Phase 5: Revenue vs costs per project
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, Loader2, AlertCircle } from 'lucide-react';
import type { ProjectProfitabilityReport } from '@/modules/accounting/types/gl.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  return {
    periodStart: start.toISOString().split('T')[0],
    periodEnd: now.toISOString().split('T')[0],
  };
}

export default function ProjectProfitabilityPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [reports, setReports] = useState<ProjectProfitabilityReport[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      const res = await apiFetch(`/api/accounting/reports-project-profitability?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      const data = json.data || json;
      setReports(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profitability');
    } finally {
      setIsLoading(false);
    }
  }, [periodStart, periodEnd]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const totals = reports.reduce(
    (acc, r) => ({ revenue: acc.revenue + r.revenue, costs: acc.costs + r.costs, profit: acc.profit + r.profit }),
    { revenue: 0, costs: 0, profit: 0 }
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting?tab=reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Reports
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <TrendingUp className="h-6 w-6 text-purple-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Project Profitability</h1>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
            </div>
          ) : reports.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No project financial activity in this period
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Project</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Revenue</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Costs</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Profit</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map(r => (
                    <>
                      <tr
                        key={r.projectId}
                        onClick={() => setExpanded(expanded === r.projectId ? null : r.projectId)}
                        className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)] cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{r.projectName}</td>
                        <td className="px-4 py-3 text-right font-mono text-teal-400">{formatCurrency(r.revenue)}</td>
                        <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(r.costs)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${r.profit >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                          {formatCurrency(r.profit)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono ${r.margin >= 0 ? 'text-[var(--ff-text-primary)]' : 'text-red-400'}`}>
                          {r.margin.toFixed(1)}%
                        </td>
                      </tr>
                      {expanded === r.projectId && (
                        <tr key={`${r.projectId}-detail`}>
                          <td colSpan={5} className="px-4 py-3 bg-[var(--ff-bg-primary)]">
                            <div className="grid grid-cols-2 gap-4 text-xs">
                              <div>
                                <p className="font-semibold text-teal-400 mb-1">Revenue Breakdown</p>
                                {r.revenueLines.map(l => (
                                  <div key={l.accountCode} className="flex justify-between py-0.5">
                                    <span className="text-[var(--ff-text-secondary)]">{l.accountName}</span>
                                    <span className="font-mono">{formatCurrency(l.amount)}</span>
                                  </div>
                                ))}
                              </div>
                              <div>
                                <p className="font-semibold text-red-400 mb-1">Cost Breakdown</p>
                                {r.costLines.map(l => (
                                  <div key={l.accountCode} className="flex justify-between py-0.5">
                                    <span className="text-[var(--ff-text-secondary)]">{l.accountName}</span>
                                    <span className="font-mono">{formatCurrency(l.amount)}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[var(--ff-bg-primary)] font-bold">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                    <td className="px-4 py-3 text-right font-mono text-teal-400">{formatCurrency(totals.revenue)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(totals.costs)}</td>
                    <td className={`px-4 py-3 text-right font-mono ${totals.profit >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {formatCurrency(totals.profit)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                      {totals.revenue > 0 ? ((totals.profit / totals.revenue) * 100).toFixed(1) : '0.0'}%
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
