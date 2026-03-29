/**
 * Financial Analysis Dashboard
 * Extended ratios, KPI scorecard with traffic lights, ratio trends
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowLeft, BarChart3, TrendingUp, TrendingDown, Minus, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const LineChart = dynamic(() => import('recharts').then(m => m.LineChart), { ssr: false });
const Line = dynamic(() => import('recharts').then(m => m.Line), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });

interface ScorecardItem {
  ratioKey: string;
  name: string;
  value: number;
  target: number;
  status: 'green' | 'amber' | 'red';
  percentOfTarget: number;
}

interface TrendItem {
  ratioName: string;
  values: Array<{ period: string; value: number }>;
  trend: 'improving' | 'declining' | 'stable';
  changePercent: number;
}

const statusColors = { green: 'text-teal-400 bg-teal-500/10 border-teal-500/30', amber: 'text-amber-400 bg-amber-500/10 border-amber-500/30', red: 'text-red-400 bg-red-500/10 border-red-500/30' };
const statusDots = { green: 'bg-teal-400', amber: 'bg-amber-400', red: 'bg-red-400' };
const trendIcons = { improving: TrendingUp, declining: TrendingDown, stable: Minus };
const trendColors = { improving: 'text-teal-400', declining: 'text-red-400', stable: 'text-gray-400' };

const RATIO_GROUPS: Record<string, string[]> = {
  Profitability: ['grossProfitMargin', 'netProfitMargin', 'ebitdaMargin', 'returnOnEquity', 'returnOnAssets', 'roce'],
  Liquidity: ['currentRatio', 'quickRatio', 'cashRatio', 'operatingCashFlowRatio'],
  Efficiency: ['debtorDays', 'creditorDays', 'assetTurnover', 'cashConversionCycle', 'inventoryTurnover'],
  Leverage: ['debtToEquity', 'debtRatio', 'interestCoverage', 'equityMultiplier'],
};

const fmt = (v: number) => v >= 1000 ? `R ${(v / 1000).toFixed(0)}K` : v >= 100 ? v.toFixed(0) : v.toFixed(2);

export default function FinancialAnalysisPage() {
  const [scorecard, setScorecard] = useState<ScorecardItem[]>([]);
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [summary, setSummary] = useState<{ green: number; amber: number; red: number; total: number } | null>(null);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(6);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const now = new Date();
      const to = now.toISOString().split('T')[0];
      const fromDate = new Date(now.getFullYear(), now.getMonth() - months, 1);
      const from = fromDate.toISOString().split('T')[0];
      const [scRes, trRes] = await Promise.all([
        apiFetch(`/api/accounting/reports-kpi-scorecard?from=${from}&to=${to}`).then(r => r.json()),
        apiFetch(`/api/accounting/reports-ratio-trends?months=${months}`).then(r => r.json()),
      ]);
      if (scRes.data) {
        setScorecard(scRes.data.scorecard || []);
        setSummary(scRes.data.summary || null);
      }
      if (trRes.data) {
        setTrends(trRes.data.trends || []);
      }
      const ratioRes = await apiFetch(`/api/accounting/reports-extended-ratios?from=${from}&to=${to}`).then(r => r.json());
      if (ratioRes.data?.ratios) setRatios(ratioRes.data.ratios);
    } catch { /* handled by empty states */ }
    finally { setLoading(false); }
  }, [months]);

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
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Financial Analysis</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">KPI Scorecard, Ratios & Trends — Syft-style analytics</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-7xl">
          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 text-teal-500 animate-spin" /></div>
          ) : (
            <>
              {/* KPI Scorecard Summary */}
              {summary && (
                <div className="grid grid-cols-4 gap-4">
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 text-center">
                    <p className="text-3xl font-bold text-[var(--ff-text-primary)]">{summary.total}</p>
                    <p className="text-xs text-[var(--ff-text-tertiary)]">Total KPIs</p>
                  </div>
                  <div className="bg-teal-500/5 rounded-lg border border-teal-500/20 p-4 text-center">
                    <p className="text-3xl font-bold text-teal-400">{summary.green}</p>
                    <p className="text-xs text-teal-400/70">On Target</p>
                  </div>
                  <div className="bg-amber-500/5 rounded-lg border border-amber-500/20 p-4 text-center">
                    <p className="text-3xl font-bold text-amber-400">{summary.amber}</p>
                    <p className="text-xs text-amber-400/70">Warning</p>
                  </div>
                  <div className="bg-red-500/5 rounded-lg border border-red-500/20 p-4 text-center">
                    <p className="text-3xl font-bold text-red-400">{summary.red}</p>
                    <p className="text-xs text-red-400/70">Critical</p>
                  </div>
                </div>
              )}

              {/* KPI Scorecard Cards */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">KPI Scorecard</h2>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                  {scorecard.map(item => (
                    <div key={item.ratioKey} className={`rounded-lg border p-3 ${statusColors[item.status]}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium opacity-70">{item.name}</span>
                        <span className={`w-2.5 h-2.5 rounded-full ${statusDots[item.status]}`} />
                      </div>
                      <p className="text-xl font-bold">{fmt(item.value)}</p>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs opacity-60">Target: {fmt(item.target)}</span>
                        <span className="text-xs font-medium">{item.percentOfTarget.toFixed(0)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Ratio Groups */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Financial Ratios (30+)</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {Object.entries(RATIO_GROUPS).map(([group, keys]) => (
                    <div key={group}>
                      <h3 className="text-sm font-semibold text-teal-400 mb-2">{group}</h3>
                      <div className="space-y-1">
                        {keys.map(key => {
                          const value = ratios[key];
                          if (value === undefined) return null;
                          const trend = trends.find(t => t.ratioName === key);
                          const TrendIcon = trend ? trendIcons[trend.trend] : Minus;
                          const trendColor = trend ? trendColors[trend.trend] : 'text-gray-400';
                          return (
                            <div key={key} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[var(--ff-bg-tertiary)]">
                              <span className="text-sm text-[var(--ff-text-secondary)]">
                                {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-mono font-medium text-[var(--ff-text-primary)]">{fmt(value)}</span>
                                {trend && <TrendIcon className={`h-3.5 w-3.5 ${trendColor}`} />}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trend Charts */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Ratio Trends</h2>
                  <select value={months} onChange={e => setMonths(Number(e.target.value))} className="ff-select text-sm">
                    <option value={3}>3 Months</option>
                    <option value={6}>6 Months</option>
                    <option value={12}>12 Months</option>
                  </select>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {['grossProfitMargin', 'currentRatio', 'debtorDays', 'returnOnEquity'].map(key => {
                    const trend = trends.find(t => t.ratioName === key);
                    if (!trend || trend.values.length === 0) return null;
                    return (
                      <div key={key}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-medium text-[var(--ff-text-secondary)]">
                            {key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}
                          </span>
                          <span className={`text-xs font-medium ${trendColors[trend.trend]}`}>
                            {trend.changePercent > 0 ? '+' : ''}{trend.changePercent.toFixed(1)}%
                          </span>
                        </div>
                        <ResponsiveContainer width="100%" height={120}>
                          <LineChart data={trend.values}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#888' }} />
                            <YAxis tick={{ fontSize: 10, fill: '#888' }} width={45} />
                            <Tooltip contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }} />
                            <Line type="monotone" dataKey="value" stroke="#14b8a6" strokeWidth={2} dot={{ r: 3 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
