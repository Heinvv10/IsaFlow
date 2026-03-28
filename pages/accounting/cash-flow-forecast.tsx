/**
 * Cash Flow Forecast
 * AI-projected cash flow based on historical patterns,
 * recurring invoices, known payables, and seasonal trends.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingUp, AlertTriangle, AlertCircle, Loader2, RefreshCw, Info } from 'lucide-react';
import dynamic from 'next/dynamic';
import { apiFetch } from '@/lib/apiFetch';

const ResponsiveContainer = dynamic(
  () => import('recharts').then(m => m.ResponsiveContainer),
  { ssr: false }
);
const AreaChart = dynamic(
  () => import('recharts').then(m => m.AreaChart),
  { ssr: false }
);
const Area = dynamic(
  () => import('recharts').then(m => m.Area),
  { ssr: false }
);
const BarChart = dynamic(
  () => import('recharts').then(m => m.BarChart),
  { ssr: false }
);
const Bar = dynamic(
  () => import('recharts').then(m => m.Bar),
  { ssr: false }
);
const XAxis = dynamic(
  () => import('recharts').then(m => m.XAxis),
  { ssr: false }
);
const YAxis = dynamic(
  () => import('recharts').then(m => m.YAxis),
  { ssr: false }
);
const CartesianGrid = dynamic(
  () => import('recharts').then(m => m.CartesianGrid),
  { ssr: false }
);
const Tooltip = dynamic(
  () => import('recharts').then(m => m.Tooltip),
  { ssr: false }
);
const Legend = dynamic(
  () => import('recharts').then(m => m.Legend),
  { ssr: false }
);

function formatCurrency(amount: number): string {
  const prefix = amount < 0 ? '-R ' : 'R ';
  return prefix + Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface ForecastPoint {
  date: string;
  label: string;
  projectedInflow: number;
  projectedOutflow: number;
  projectedNet: number;
  projectedBalance: number;
  confidence: number;
}

interface ForecastAlert {
  type: 'warning' | 'danger';
  message: string;
  date: string;
  projectedBalance: number;
}

interface HistoricalPoint {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
}

interface ForecastData {
  currentBalance: number;
  forecastPoints: ForecastPoint[];
  alerts: ForecastAlert[];
  assumptions: string[];
  historical: HistoricalPoint[];
  generatedAt: string;
}

export default function CashFlowForecastPage() {
  const [data, setData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [months, setMonths] = useState(6);

  const fetchForecast = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/cash-flow-forecast?months=${months}`);
      if (!res.ok) throw new Error('Failed to load forecast');
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load forecast');
    } finally {
      setLoading(false);
    }
  }, [months]);

  useEffect(() => { void fetchForecast(); }, [fetchForecast]);

  // Combine historical + forecast for the balance chart
  const balanceChartData = [
    ...(data?.historical ?? []).map(h => ({
      label: new Date(h.month + '-01').toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }),
      balance: null as number | null,
      projected: null as number | null,
      actual: h.net,
      type: 'historical',
    })),
    // Current balance as bridge point
    ...(data ? [{
      label: 'Now',
      balance: null,
      projected: data.currentBalance,
      actual: data.currentBalance,
      type: 'current',
    }] : []),
    ...(data?.forecastPoints ?? []).map(p => ({
      label: p.label,
      balance: null,
      projected: p.projectedBalance,
      actual: null as number | null,
      type: 'forecast',
    })),
  ];

  const inflowOutflowData = (data?.forecastPoints ?? []).map(p => ({
    label: p.label,
    inflow: p.projectedInflow,
    outflow: p.projectedOutflow,
    net: p.projectedNet,
  }));

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <TrendingUp className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Cash Flow Forecast</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                AI-projected cash position based on historical patterns and known commitments
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={months}
              onChange={e => setMonths(Number(e.target.value))}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm"
            >
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
            <button
              onClick={() => void fetchForecast()}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-center gap-2 text-red-500">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {data && !loading && (
          <>
            {/* Alerts */}
            {data.alerts.length > 0 && (
              <div className="space-y-2">
                {data.alerts.map((alert, i) => (
                  <div
                    key={i}
                    className={`rounded-lg p-4 flex items-center gap-3 ${
                      alert.type === 'danger'
                        ? 'bg-red-500/10 border border-red-500/30 text-red-500'
                        : 'bg-amber-500/10 border border-amber-500/30 text-amber-500'
                    }`}
                  >
                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                    <div>
                      <p className="font-medium">{alert.message}</p>
                      <p className="text-sm opacity-80">Projected balance: {formatCurrency(alert.projectedBalance)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Key Metrics */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Current Cash"
                value={formatCurrency(data.currentBalance)}
                color="teal"
              />
              {data.forecastPoints.length > 0 && (() => {
                const lastPoint = data.forecastPoints[data.forecastPoints.length - 1]!;
                return (
                <>
                  <MetricCard
                    label={`Projected (${lastPoint.label})`}
                    value={formatCurrency(lastPoint.projectedBalance)}
                    color={lastPoint.projectedBalance >= data.currentBalance ? 'teal' : 'rose'}
                  />
                  <MetricCard
                    label="Avg Monthly Inflow"
                    value={formatCurrency(
                      data.forecastPoints.reduce((s, p) => s + p.projectedInflow, 0) / data.forecastPoints.length
                    )}
                    color="teal"
                  />
                  <MetricCard
                    label="Avg Monthly Outflow"
                    value={formatCurrency(
                      data.forecastPoints.reduce((s, p) => s + p.projectedOutflow, 0) / data.forecastPoints.length
                    )}
                    color="orange"
                  />
                </>
                );
              })()}
            </div>

            {/* Balance Projection Chart */}
            <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Projected Cash Balance</h2>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={balanceChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-primary)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--ff-text-secondary)', fontSize: 12 }} />
                    <YAxis
                      tick={{ fill: 'var(--ff-text-secondary)', fontSize: 12 }}
                      tickFormatter={(v: number) => `R ${(v / 1000).toFixed(0)}k`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--ff-surface-primary)',
                        border: '1px solid var(--ff-border-primary)',
                        borderRadius: '8px',
                        color: 'var(--ff-text-primary)',
                      }}
                      formatter={(value) => [formatCurrency(Number(value)), '']}
                    />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="actual"
                      name="Actual"
                      stroke="#14b8a6"
                      fill="#14b8a6"
                      fillOpacity={0.3}
                      connectNulls={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="projected"
                      name="Projected"
                      stroke="#14b8a6"
                      strokeDasharray="5 5"
                      fill="#14b8a6"
                      fillOpacity={0.1}
                      connectNulls={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Inflow vs Outflow Chart */}
            <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Projected Inflows vs Outflows</h2>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={inflowOutflowData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--ff-border-primary)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--ff-text-secondary)', fontSize: 12 }} />
                    <YAxis
                      tick={{ fill: 'var(--ff-text-secondary)', fontSize: 12 }}
                      tickFormatter={(v: number) => `R ${(v / 1000).toFixed(0)}k`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--ff-surface-primary)',
                        border: '1px solid var(--ff-border-primary)',
                        borderRadius: '8px',
                        color: 'var(--ff-text-primary)',
                      }}
                      formatter={(value) => [formatCurrency(Number(value)), '']}
                    />
                    <Legend />
                    <Bar dataKey="inflow" name="Inflow" fill="#2dd4bf" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="outflow" name="Outflow" fill="#fb923c" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Forecast Details Table */}
            <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--ff-border-primary)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Monthly Breakdown</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[var(--ff-bg-secondary)]">
                      <th className="text-left px-6 py-3 font-medium text-[var(--ff-text-secondary)]">Month</th>
                      <th className="text-right px-6 py-3 font-medium text-[var(--ff-text-secondary)]">Inflow</th>
                      <th className="text-right px-6 py-3 font-medium text-[var(--ff-text-secondary)]">Outflow</th>
                      <th className="text-right px-6 py-3 font-medium text-[var(--ff-text-secondary)]">Net</th>
                      <th className="text-right px-6 py-3 font-medium text-[var(--ff-text-secondary)]">Balance</th>
                      <th className="text-center px-6 py-3 font-medium text-[var(--ff-text-secondary)]">Confidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-primary)]">
                    {data.forecastPoints.map((p, i) => (
                      <tr key={i} className="hover:bg-[var(--ff-bg-hover)]">
                        <td className="px-6 py-3 text-[var(--ff-text-primary)] font-medium">{p.label}</td>
                        <td className="px-6 py-3 text-right text-teal-500">{formatCurrency(p.projectedInflow)}</td>
                        <td className="px-6 py-3 text-right text-orange-500">{formatCurrency(p.projectedOutflow)}</td>
                        <td className={`px-6 py-3 text-right font-medium ${p.projectedNet >= 0 ? 'text-teal-500' : 'text-red-500'}`}>
                          {formatCurrency(p.projectedNet)}
                        </td>
                        <td className={`px-6 py-3 text-right font-semibold ${p.projectedBalance >= 0 ? 'text-[var(--ff-text-primary)]' : 'text-red-500'}`}>
                          {formatCurrency(p.projectedBalance)}
                        </td>
                        <td className="px-6 py-3 text-center">
                          <ConfidenceBadge value={p.confidence} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Assumptions */}
            <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <div className="flex items-center gap-2 mb-3">
                <Info className="h-4 w-4 text-[var(--ff-text-secondary)]" />
                <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">Forecast Assumptions</h3>
              </div>
              <ul className="space-y-1">
                {data.assumptions.map((a, i) => (
                  <li key={i} className="text-sm text-[var(--ff-text-secondary)] flex items-start gap-2">
                    <span className="text-teal-500 mt-1">•</span>
                    {a}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-3">
                Generated at {new Date(data.generatedAt).toLocaleString('en-ZA')}
              </p>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  const bgMap: Record<string, string> = {
    teal: 'border-teal-500/30 bg-teal-500/5',
    rose: 'border-rose-500/30 bg-rose-500/5',
    orange: 'border-orange-500/30 bg-orange-500/5',
  };
  const textMap: Record<string, string> = {
    teal: 'text-teal-500',
    rose: 'text-rose-500',
    orange: 'text-orange-500',
  };
  return (
    <div className={`rounded-xl border p-4 ${bgMap[color] || bgMap.teal}`}>
      <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${textMap[color] || textMap.teal}`}>{value}</p>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  let cls = 'bg-teal-500/20 text-teal-500';
  if (pct < 50) cls = 'bg-red-500/20 text-red-500';
  else if (pct < 70) cls = 'bg-amber-500/20 text-amber-500';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {pct}%
    </span>
  );
}
