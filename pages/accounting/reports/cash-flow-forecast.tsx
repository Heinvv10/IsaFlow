/**
 * AI Cash Flow Forecast Page
 * Horizon selector (30/60/90 days), area chart, KPI cards, risks, opportunities, AI summary.
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingUp, Loader2, AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  CashFlowForecastChart,
  KpiCard,
  ConfidencePip,
  buildChartData,
  fmtCurrency,
  fmtShortDate,
  type CashFlowForecast,
} from '@/components/accounting/CashFlowForecastChart';

const HORIZON_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '60 days', value: 60 },
  { label: '90 days', value: 90 },
] as const;

export default function AICashFlowForecastPage() {
  const [horizon, setHorizon] = useState<30 | 60 | 90>(30);
  const [forecast, setForecast] = useState<CashFlowForecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState(false);

  const generate = useCallback(async (selectedHorizon: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/cash-flow-forecast?horizon=${selectedHorizon}`);
      if (!res.ok) {
        const body = await res.json() as { error?: { message?: string } };
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json() as { data: CashFlowForecast };
      setForecast(json.data);
      setGenerated(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate forecast';
      log.error('Cash flow forecast failed', { error: msg }, 'ui');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleHorizonChange = (h: 30 | 60 | 90) => {
    setHorizon(h);
    if (generated) void generate(h);
  };

  const totalInflows = forecast?.forecastPeriods.reduce((s, w) => s + w.projectedInflows, 0) ?? 0;
  const totalOutflows = forecast?.forecastPeriods.reduce((s, w) => s + w.projectedOutflows, 0) ?? 0;
  const chartData = forecast ? buildChartData(forecast) : [];

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-teal-500/10 border border-teal-500/20">
              <TrendingUp className="h-6 w-6 text-teal-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">AI Cash Flow Forecast</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Bank transaction actuals + AI-projected weekly cash flow
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-[var(--ff-border-primary)] overflow-hidden">
              {HORIZON_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleHorizonChange(opt.value)}
                  className={`px-3 py-2 text-sm font-medium transition-colors ${
                    horizon === opt.value
                      ? 'bg-teal-600 text-white'
                      : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void generate(horizon)}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : generated ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              {loading ? 'Generating...' : generated ? 'Refresh' : 'Generate Forecast'}
            </button>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2 className="h-10 w-10 animate-spin text-teal-500" />
            <p className="text-[var(--ff-text-secondary)] text-sm">Analysing your cash flow data with AI...</p>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-start gap-3 text-red-400">
            <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Forecast failed</p>
              <p className="text-sm opacity-80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Empty prompt */}
        {!loading && !error && !forecast && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-[var(--ff-text-secondary)]">
            <div className="p-4 rounded-full bg-teal-500/10 border border-teal-500/20">
              <Sparkles className="h-8 w-8 text-teal-400" />
            </div>
            <div className="text-center">
              <p className="font-semibold text-[var(--ff-text-primary)]">Ready to forecast</p>
              <p className="text-sm mt-1">Select a horizon and click <strong>Generate Forecast</strong>.</p>
            </div>
          </div>
        )}

        {/* Results */}
        {forecast && !loading && (
          <>
            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard label="Current Balance" value={fmtCurrency(forecast.currentCashBalance)} sub="from bank transactions" accent="blue" />
              <KpiCard
                label="Projected End Balance"
                value={fmtCurrency(forecast.projectedEndBalance)}
                sub={`after ${horizon} days`}
                accent={forecast.projectedEndBalance >= forecast.currentCashBalance ? 'teal' : 'rose'}
              />
              <KpiCard label="Total Projected Inflows" value={fmtCurrency(totalInflows)} sub={`${forecast.forecastPeriods.length} weeks`} accent="teal" />
              <KpiCard label="Total Projected Outflows" value={fmtCurrency(totalOutflows)} sub={`${forecast.forecastPeriods.length} weeks`} accent="amber" />
            </div>

            {/* Chart */}
            <CashFlowForecastChart data={chartData} />

            {/* Forecast table */}
            <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--ff-border-primary)]">
                <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Weekly Forecast Detail</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[var(--ff-bg-secondary)] text-xs uppercase tracking-wider text-[var(--ff-text-secondary)]">
                      <th className="text-left px-5 py-3">Week</th>
                      <th className="text-right px-5 py-3">Inflows</th>
                      <th className="text-right px-5 py-3">Outflows</th>
                      <th className="text-right px-5 py-3">Net</th>
                      <th className="text-center px-5 py-3">Confidence</th>
                      <th className="text-left px-5 py-3">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-primary)]">
                    {forecast.forecastPeriods.map((w, i) => (
                      <tr key={i} className="hover:bg-[var(--ff-bg-hover)]">
                        <td className="px-5 py-3 text-[var(--ff-text-primary)] font-medium whitespace-nowrap">{fmtShortDate(w.weekStart)}</td>
                        <td className="px-5 py-3 text-right text-teal-400 tabular-nums">{fmtCurrency(w.projectedInflows)}</td>
                        <td className="px-5 py-3 text-right text-amber-400 tabular-nums">{fmtCurrency(w.projectedOutflows)}</td>
                        <td className={`px-5 py-3 text-right font-semibold tabular-nums ${w.projectedNet >= 0 ? 'text-teal-400' : 'text-rose-400'}`}>
                          {fmtCurrency(w.projectedNet)}
                        </td>
                        <td className="px-5 py-3 text-center"><ConfidencePip confidence={w.confidence} /></td>
                        <td className="px-5 py-3 text-[var(--ff-text-secondary)] max-w-xs truncate">{w.notes}</td>
                      </tr>
                    ))}
                    {forecast.forecastPeriods.length === 0 && (
                      <tr><td colSpan={6} className="px-5 py-8 text-center text-[var(--ff-text-secondary)]">No forecast weeks generated.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Risks & Opportunities */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <BadgeList title="Risks" items={forecast.risks} accent="rose" tag="Risk" empty="No specific risks identified." />
              <BadgeList title="Opportunities" items={forecast.opportunities} accent="teal" tag="Opp" empty="No specific opportunities identified." />
            </div>

            {/* AI Summary */}
            <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-teal-400" />
                <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider">AI Analysis</h3>
              </div>
              <p className="text-sm text-[var(--ff-text-primary)] leading-relaxed">{forecast.summary}</p>
              <p className="text-xs text-[var(--ff-text-secondary)] mt-3">
                Generated at {new Date(forecast.generatedAt).toLocaleString('en-ZA')} &middot;{' '}
                {forecast.historicalPeriods.length} historical weeks &middot; {horizon}-day horizon
              </p>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}

// ── Inline sub-component (simple enough to keep here) ─────────────────────────

function BadgeList({
  title, items, accent, tag, empty,
}: {
  title: string; items: string[]; accent: 'rose' | 'teal'; tag: string; empty: string;
}) {
  const headCls = accent === 'rose' ? 'text-rose-400' : 'text-teal-400';
  const badgeCls = accent === 'rose'
    ? 'bg-rose-500/20 text-rose-400 border-rose-500/30'
    : 'bg-teal-500/20 text-teal-400 border-teal-500/30';
  return (
    <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
      <h3 className={`text-sm font-semibold uppercase tracking-wider mb-3 ${headCls}`}>{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-secondary)]">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full border text-xs font-medium shrink-0 ${badgeCls}`}>{tag}</span>
              <p className="text-sm text-[var(--ff-text-secondary)]">{item}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
