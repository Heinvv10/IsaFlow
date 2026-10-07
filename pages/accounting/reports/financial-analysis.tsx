/**
 * Financial Analysis Dashboard
 * Extended ratios, KPI scorecard with traffic lights, ratio trends
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { ArrowLeft, BarChart3, TrendingUp, TrendingDown, Minus, Loader2 } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import {
  DataQualityNotice,
  type UnclassifiedWarning,
  type InventoryWarning,
} from '@/components/accounting/DataQualityNotice';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { ratioLabel, ratioLine } from '@/modules/accounting/services/reports/ratioPresentation';
import { scorecardFigure } from '@/modules/accounting/services/packs/packKvFormat';
// The note only: the chart itself loads through `dynamic` below.
import { RATIO_TREND_STUB_NOTE } from '@/components/accounting/charts/ratioTrendStub';

const RatioTrendChart = dynamic(
  () => import('@/components/accounting/charts/RatioTrendChart').then(m => m.RatioTrendChart), { ssr: false },
);

interface ScorecardItem {
  ratioKey: string;
  name: string;
  value: number | null;
  target: number;
  status: 'green' | 'amber' | 'red' | 'not_meaningful';
  reason?: string;
  percentOfTarget: number;
}

interface TrendItem {
  ratioName: string;
  /** A point is null where the ratio could not be stated in that period. */
  values: Array<{ period: string; value: number | null; partial: boolean }>;
  trend: 'improving' | 'declining' | 'stable' | 'not_meaningful';
  changePercent: number | null;
}

const statusColors = { green: 'text-teal-400 bg-teal-500/10 border-teal-500/30', amber: 'text-amber-400 bg-amber-500/10 border-amber-500/30', red: 'text-red-400 bg-red-500/10 border-red-500/30', not_meaningful: 'text-[var(--ff-text-secondary)] bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)]' };
const statusDots = { green: 'bg-teal-400', amber: 'bg-amber-400', red: 'bg-red-400', not_meaningful: 'bg-[var(--ff-text-secondary)]' };
const trendIcons = { improving: TrendingUp, declining: TrendingDown, stable: Minus, not_meaningful: Minus };
const trendColors = { improving: 'text-teal-400', declining: 'text-red-400', stable: 'text-gray-400', not_meaningful: 'text-gray-400' };

const RATIO_GROUPS: Record<string, string[]> = {
  Profitability: ['grossProfitMargin', 'netProfitMargin', 'ebitdaMargin', 'returnOnEquity', 'returnOnAssets', 'roce'],
  Liquidity: ['currentRatio', 'quickRatio', 'cashRatio', 'operatingCashFlowRatio'],
  Efficiency: ['debtorDays', 'creditorDays', 'assetTurnover', 'cashConversionCycle', 'inventoryTurnover'],
  Leverage: ['debtToEquity', 'debtRatio', 'interestCoverage', 'equityMultiplier'],
  'Cash Flow': ['freeCashFlow'],
};

/** A scored tile's figures; only called on the scored branch. */
const scored = (item: ScorecardItem): { value: string; target: string } => {
  const figure = scorecardFigure(item);
  return figure.scored ? figure : { value: figure.reason, target: figure.target };
};

export default function FinancialAnalysisPage() {
  const [scorecard, setScorecard] = useState<ScorecardItem[]>([]);
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [summary, setSummary] = useState<{ green: number; amber: number; red: number; total: number } | null>(null);
  // A ratio is null where the engine could not state it; its reason is in
  // the result's own `notMeaningful` map, under the same key.
  const [ratios, setRatios] = useState<Record<string, number | null>>({});
  const [ratioReasons, setRatioReasons] = useState<Record<string, string>>({});
  const [inventoryWarning, setInventoryWarning] = useState<InventoryWarning | null>(null);
  const [unclassified, setUnclassified] = useState<UnclassifiedWarning | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(6);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    const getJson = async (url: string) => {
      const res = await apiFetch(url);
      await assertOk(res, 'Could not load the financial analysis - try again');
      return res.json();
    };
    try {
      const now = new Date();
      const to = localISODate(now);
      const fromDate = new Date(now.getFullYear(), now.getMonth() - months, 1);
      const from = localISODate(fromDate);
      const [scRes, trRes] = await Promise.all([
        getJson(`/api/accounting/reports-kpi-scorecard?from=${from}&to=${to}`),
        getJson(`/api/accounting/reports-ratio-trends?months=${months}`),
      ]);
      if (scRes.data) {
        setScorecard(scRes.data.scorecard || []);
        setSummary(scRes.data.summary || null);
        // The quick ratio on this page does not exclude inventory unless the
        // chart classifies one — say so rather than showing quick == current.
        setInventoryWarning(scRes.data.inventory ?? null);
      }
      if (trRes.data) {
        setTrends(trRes.data.trends || []);
      }
      const ratioRes = await getJson(`/api/accounting/reports-extended-ratios?from=${from}&to=${to}`);
      if (ratioRes.data?.ratios) {
        const { notMeaningful, ...values } = ratioRes.data.ratios;
        setRatios(values);
        setRatioReasons(notMeaningful ?? {});
      }
      if (ratioRes.data) setUnclassified(ratioRes.data.unclassifiedAccounts ?? null);
    } catch (err) {
      setScorecard([]); setTrends([]); setSummary(null); setRatios({}); setInventoryWarning(null); setUnclassified(null);
      log.error('Failed to load financial analysis data', { error: err }, 'FinancialAnalysisPage'); setError(apiErrorMessage(err, 'Could not load the financial analysis - try again')); }
    finally { setLoading(false); }
  }, [months]);

  useEffect(() => { void loadData(); }, [loadData]);

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
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 text-teal-500 animate-spin" /></div>
          ) : (
            <>
              <DataQualityNotice
                unclassifiedAccounts={unclassified}
                inventory={inventoryWarning}
              />

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
                    <div key={item.ratioKey} data-kpi={item.ratioKey} className={`rounded-lg border p-3 ${statusColors[item.status]}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium opacity-70">{item.name}</span>
                        <span className={`w-2.5 h-2.5 rounded-full ${statusDots[item.status]}`} />
                      </div>
                      {item.status === 'not_meaningful' ? (
                        <>
                          {/* A blank cell reads as a broken report. Say what is
                              true instead: the ratio has no meaning here. */}
                          <p className="text-sm font-semibold">Not meaningful</p>
                          <p className="mt-1 text-xs opacity-70">{item.reason}</p>
                        </>
                      ) : (
                        <>
                          {/* Value and target in the ratio's own unit — the tile's
                              decision, shared with every pack surface. It printed
                              "Target: 35" under a gross margin. */}
                          <p className="text-xl font-bold">{scored(item).value}</p>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-xs opacity-60">Target: {scored(item).target}</span>
                            <span className="text-xs font-medium">{item.percentOfTarget.toFixed(0)}%</span>
                          </div>
                        </>
                      )}
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
                          // Its name, and its figure in its unit — or, where
                          // the engine could not state it, the reason. Never
                          // a 0 standing in, and never `null.toFixed()`.
                          const line = ratioLine(key, value, ratioReasons);
                          const trend = trends.find(t => t.ratioName === key);
                          const TrendIcon = trend ? trendIcons[trend.trend] : Minus;
                          const trendColor = trend ? trendColors[trend.trend] : 'text-gray-400';
                          return (
                            <div key={key} data-ratio={key} className="py-1.5 px-2 rounded hover:bg-[var(--ff-bg-tertiary)]">
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-[var(--ff-text-secondary)]">{line.label}</span>
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-mono font-medium text-[var(--ff-text-primary)]">
                                    {line.stated ? line.text : 'n/m'}
                                  </span>
                                  {trend && line.stated && <TrendIcon className={`h-3.5 w-3.5 ${trendColor}`} />}
                                </div>
                              </div>
                              {!line.stated && (
                                <p className="mt-0.5 text-xs text-[var(--ff-text-tertiary)]">{line.text}</p>
                              )}
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
                          <span className="text-sm font-medium text-[var(--ff-text-secondary)]">{ratioLabel(key)}</span>
                          <span className={`text-xs font-medium ${trendColors[trend.trend]}`}>
                            {trend.changePercent === null
                              ? 'n/m'
                              : `${trend.changePercent > 0 ? '+' : ''}${trend.changePercent.toFixed(1)}%`}
                          </span>
                        </div>
                        <RatioTrendChart values={trend.values} />
                      </div>
                    );
                  })}
                </div>
                {trends.some(t => t.values.some(v => v.partial)) && (
                  <p className="mt-3 text-xs text-[var(--ff-text-secondary)]">{RATIO_TREND_STUB_NOTE}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
