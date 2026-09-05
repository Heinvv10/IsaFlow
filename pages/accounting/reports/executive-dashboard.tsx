/**
 * Executive Dashboard
 * KPI cards + waterfalls + scorecard + alerts in one page
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  ArrowLeft, LayoutDashboard, TrendingUp, TrendingDown, Minus,
  AlertTriangle, AlertCircle, CheckCircle, Loader2,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  DataQualityNotice,
  type UnclassifiedWarning,
  type InventoryWarning,
} from '@/components/accounting/DataQualityNotice';
import { KpiTile } from '@/components/accounting/kpi/KpiTile';
import { log } from '@/lib/logger';

const BarChart = dynamic(() => import('recharts').then(m => m.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(m => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(m => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(m => m.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(m => m.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });

interface ExecutiveKPIs {
  revenue: number;
  netProfit: number;
  grossProfitMargin: number;
  netProfitMargin: number;
  revenueGrowth: number;
  profitGrowth: number;
  currentRatio: number;
  debtToEquity: number;
  cashBalance: number;
}

interface CashPosition {
  cashBalance: number;
  accountsReceivable: number;
  accountsPayable: number;
  netWorkingCapital: number;
  currentRatio: number;
}

interface Highlight { type: 'positive' | 'negative' | 'neutral'; message: string }
interface Alert { severity: 'info' | 'warning' | 'danger'; message: string }
interface Summary { period: string; companyName: string; kpis: ExecutiveKPIs; cashPosition: CashPosition; highlights: Highlight[]; alerts: Alert[] }

const alertIcon = { info: CheckCircle, warning: AlertTriangle, danger: AlertCircle };
const alertColor = { info: 'border-teal-500/30 bg-teal-500/10 text-teal-400', warning: 'border-amber-500/30 bg-amber-500/10 text-amber-400', danger: 'border-red-500/30 bg-red-500/10 text-red-400' };

export default function ExecutiveDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scorecard, setScorecard] = useState<Array<{ ratioKey: string; name: string; value: number | null; target: number; status: 'green' | 'amber' | 'red' | 'not_meaningful'; reason?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [unclassified, setUnclassified] = useState<UnclassifiedWarning | null>(null);
  const [inventory, setInventory] = useState<InventoryWarning | null>(null);
  const [from, setFrom] = useState(() => new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!);
  const [to, setTo] = useState(() => new Date().toISOString().split('T')[0]!);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, scRes] = await Promise.all([
        apiFetch(`/api/accounting/reports-executive-summary?from=${from}&to=${to}`).then(r => r.json()),
        apiFetch(`/api/accounting/reports-kpi-scorecard?from=${from}&to=${to}`).then(r => r.json()),
      ]);
      if (sumRes.data?.summary) setSummary(sumRes.data.summary);
      if (sumRes.data) setUnclassified(sumRes.data.unclassifiedAccounts ?? null);
      if (scRes.data?.scorecard) setScorecard(scRes.data.scorecard);
      if (scRes.data) setInventory(scRes.data.inventory ?? null);
    } catch (err) { log.error('Failed to load executive summary', { error: err instanceof Error ? err.message : String(err) }); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { void loadData(); }, [loadData]);

  const cashChartData = summary ? [
    { name: 'Cash', value: summary.cashPosition.cashBalance },
    { name: 'AR', value: summary.cashPosition.accountsReceivable },
    { name: 'AP', value: summary.cashPosition.accountsPayable },
    { name: 'NWC', value: summary.cashPosition.netWorkingCapital },
  ] : [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><LayoutDashboard className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Executive Dashboard</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">KPI overview, cash position & alerts</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="ff-input text-sm" />
              <span className="text-[var(--ff-text-secondary)]">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="ff-input text-sm" />
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-7xl">
          <DataQualityNotice unclassifiedAccounts={unclassified} inventory={inventory} />
          {loading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 text-teal-500 animate-spin" /></div>
          ) : summary ? (
            <>
              {/* Alerts */}
              {summary.alerts.length > 0 && (
                <div className="space-y-2">
                  {summary.alerts.map((alert, i) => {
                    const Icon = alertIcon[alert.severity];
                    return (
                      <div key={i} className={`flex items-start gap-2 p-3 rounded-lg border ${alertColor[alert.severity]}`}>
                        <Icon className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <span className="text-sm">{alert.message}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* KPI Cards */}
              <div className="grid grid-cols-3 md:grid-cols-5 gap-4">
                <KpiTile label="Revenue" value={summary.kpis.revenue} kind="money" deltaPct={summary.kpis.revenueGrowth} favourable={summary.kpis.revenueGrowth >= 0} />
                <KpiTile label="Net profit" value={summary.kpis.netProfit} kind="money" deltaPct={summary.kpis.profitGrowth} favourable={summary.kpis.profitGrowth >= 0} />
                <KpiTile label="Gross margin" value={summary.kpis.grossProfitMargin} kind="pct" />
                <KpiTile label="Net margin" value={summary.kpis.netProfitMargin} kind="pct" />
                <KpiTile label="Cash balance" value={summary.kpis.cashBalance} kind="money" />
                <KpiTile label="Current ratio" value={summary.kpis.currentRatio} kind="ratio" />
                <KpiTile label="Debt/equity" value={summary.kpis.debtToEquity} kind="ratio" />
                <KpiTile label="NWC" value={summary.cashPosition.netWorkingCapital} kind="money" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Cash Position Chart */}
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                  <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Cash Position</h2>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={cashChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#888' }} />
                      <YAxis tick={{ fontSize: 10, fill: '#888' }} width={60} tickFormatter={v => `R${(v / 1000).toFixed(0)}K`} />
                      <Tooltip contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', borderRadius: 8 }} formatter={(v) => [`R ${Number(v).toLocaleString('en-ZA')}`, '']} />
                      <Bar dataKey="value" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Highlights */}
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                  <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Key Highlights</h2>
                  <div className="space-y-2">
                    {summary.highlights.map((h, i) => (
                      <div key={i} className={`flex items-start gap-2 p-2 rounded text-sm ${h.type === 'positive' ? 'text-teal-400' : h.type === 'negative' ? 'text-red-400' : 'text-[var(--ff-text-secondary)]'}`}>
                        {h.type === 'positive' ? <TrendingUp className="h-4 w-4 mt-0.5 flex-shrink-0" /> : h.type === 'negative' ? <TrendingDown className="h-4 w-4 mt-0.5 flex-shrink-0" /> : <Minus className="h-4 w-4 mt-0.5 flex-shrink-0" />}
                        {h.message}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* KPI Scorecard */}
              {scorecard.length > 0 && (
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
                  <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">KPI Scorecard</h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {scorecard.slice(0, 8).map(item => (
                      <div key={item.ratioKey} className={`rounded-lg border p-3 ${item.status === 'green' ? 'border-teal-500/30 bg-teal-500/10' : item.status === 'amber' ? 'border-amber-500/30 bg-amber-500/10' : item.status === 'not_meaningful' ? 'border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]' : 'border-red-500/30 bg-red-500/10'}`}>
                        <div className="flex justify-between mb-1">
                          <span className="text-xs opacity-70">{item.name}</span>
                          <span className={`w-2 h-2 rounded-full ${item.status === 'green' ? 'bg-teal-400' : item.status === 'amber' ? 'bg-amber-400' : item.status === 'not_meaningful' ? 'bg-[var(--ff-text-secondary)]' : 'bg-red-400'}`} />
                        </div>
                        {item.status === 'not_meaningful' || item.value === null ? (
                          <>
                            {/* Stating the condition beats an empty cell, which
                                reads as a broken report rather than a true one. */}
                            <p className="text-sm font-semibold text-[var(--ff-text-secondary)]">Not meaningful</p>
                            <p className="text-xs opacity-60">{item.reason}</p>
                          </>
                        ) : (
                          <>
                            <p className={`text-lg font-bold ${item.status === 'green' ? 'text-teal-400' : item.status === 'amber' ? 'text-amber-400' : 'text-red-400'}`}>{item.value.toFixed(2)}</p>
                            <p className="text-xs opacity-60">Target: {item.target}</p>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-[var(--ff-text-secondary)]">
              <LayoutDashboard className="h-12 w-12 mb-3 opacity-30" />
              <p>No financial data available for the selected period.</p>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
