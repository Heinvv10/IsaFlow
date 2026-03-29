/**
 * Trend Analysis — Revenue, Expenses, Net Profit, Cash trends with moving averages
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowLeft, TrendingUp, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { TrendAnalysis as TrendData } from '@/modules/accounting/services/trendAnalysisService';

const LineChart = dynamic(() => import('recharts').then(m => m.LineChart), { ssr: false });
const Line = dynamic(() => import('recharts').then(m => m.Line), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });
const ReferenceDot = dynamic(() => import('recharts').then(m => m.ReferenceDot), { ssr: false });

type Metric = 'revenue' | 'expenses' | 'netProfit' | 'cash';
const METRIC_LABELS: Record<Metric, string> = { revenue: 'Revenue', expenses: 'Expenses', netProfit: 'Net Profit', cash: 'Cash Balance' };
const fmt = (n: number) => n >= 1000000 ? `R ${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `R ${(n / 1000).toFixed(0)}K` : `R ${n.toFixed(0)}`;

export default function TrendAnalysisPage() {
  const [metric, setMetric] = useState<Metric>('revenue');
  const [months, setMonths] = useState(6);
  const [analysis, setAnalysis] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/reports-trend-analysis?metric=${metric}&months=${months}`);
      const json = await res.json();
      if (json.data?.analysis) setAnalysis(json.data.analysis);
    } catch { /* empty */ }
    finally { setLoading(false); }
  }, [metric, months]);

  useEffect(() => { loadData(); }, [loadData]);

  // Build chart data with MA overlay
  const chartData = analysis?.dataPoints.map((dp, i) => ({
    period: dp.period,
    value: dp.value,
    ma3: analysis.movingAverage3[i],
    isAnomaly: analysis.anomalies.includes(i),
  })) || [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><TrendingUp className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Trend Analysis</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Growth rates, moving averages, anomaly detection</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {/* Controls */}
          <div className="flex gap-3">
            <select value={metric} onChange={e => setMetric(e.target.value as Metric)} className="ff-select text-sm">
              {Object.entries(METRIC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={months} onChange={e => setMonths(Number(e.target.value))} className="ff-select text-sm">
              <option value={3}>3 Months</option>
              <option value={6}>6 Months</option>
              <option value={12}>12 Months</option>
            </select>
          </div>

          {loading ? (
            <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 text-teal-500 animate-spin" /></div>
          ) : analysis ? (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">CMGR (Monthly Growth)</p>
                  <p className={`text-2xl font-bold ${analysis.cmgr >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                    {analysis.cmgr >= 0 ? '+' : ''}{analysis.cmgr.toFixed(2)}%
                  </p>
                </div>
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Latest Value</p>
                  <p className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    {fmt(analysis.dataPoints[analysis.dataPoints.length - 1]?.value || 0)}
                  </p>
                </div>
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Anomalies Detected</p>
                  <p className={`text-2xl font-bold ${analysis.anomalies.length > 0 ? 'text-amber-400' : 'text-teal-400'}`}>
                    {analysis.anomalies.length}
                  </p>
                </div>
              </div>

              {/* Main chart */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">{METRIC_LABELS[metric]} Trend</h2>
                <ResponsiveContainer width="100%" height={350}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="period" tick={{ fontSize: 11, fill: '#888' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#888' }} tickFormatter={fmt} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }}
                      formatter={(val) => [fmt(Number(val || 0)), '']}
                    />
                    <Line type="monotone" dataKey="value" stroke="#14b8a6" strokeWidth={2} dot={{ r: 4 }} name={METRIC_LABELS[metric]} />
                    <Line type="monotone" dataKey="ma3" stroke="#fbbf24" strokeWidth={1.5} strokeDasharray="5 5" dot={false} name="3-Month MA" />
                    {analysis.anomalies.map(idx => (
                      <ReferenceDot
                        key={idx}
                        x={chartData[idx]?.period}
                        y={chartData[idx]?.value}
                        r={8}
                        fill="#f43f5e"
                        stroke="#f43f5e"
                        strokeWidth={2}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Growth rates table */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Month-over-Month Growth</h2>
                <div className="grid grid-cols-5 gap-3">
                  {analysis.growthRates.map((rate, i) => (
                    <div key={i} className="text-center p-2 rounded bg-[var(--ff-bg-tertiary)]">
                      <p className="text-xs text-[var(--ff-text-tertiary)]">
                        {analysis.dataPoints[i]?.period} → {analysis.dataPoints[i + 1]?.period}
                      </p>
                      <p className={`text-lg font-bold ${rate >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                        {rate >= 0 ? '+' : ''}{rate.toFixed(1)}%
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Anomalies */}
              {analysis.anomalies.length > 0 && (
                <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                    <h3 className="text-sm font-semibold text-amber-400">Anomalies Detected</h3>
                  </div>
                  {analysis.anomalies.map(idx => (
                    <p key={idx} className="text-sm text-amber-300/80">
                      {analysis.dataPoints[idx]?.period}: {fmt(analysis.dataPoints[idx]?.value || 0)} — significantly deviates from average
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-center text-[var(--ff-text-tertiary)] py-10">No trend data available</p>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
