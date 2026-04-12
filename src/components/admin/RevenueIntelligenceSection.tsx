/**
 * Revenue Intelligence Section
 * Rendered inside AdminAnalytics. Fetches /api/admin/analytics/revenue independently.
 */

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2 } from 'lucide-react';
import type { RevenueIntelligence } from '@/modules/admin/types/admin.types';

const PlanBreakdownChart  = dynamic(
  () => import('./charts/PlanBreakdownChart').then((m) => m.PlanBreakdownChart),
  { ssr: false },
);
const ChurnTrendChart     = dynamic(
  () => import('./charts/ChurnTrendChart').then((m) => m.ChurnTrendChart),
  { ssr: false },
);
const CohortRetentionTable = dynamic(
  () => import('./charts/CohortRetentionTable').then((m) => m.CohortRetentionTable),
  { ssr: false },
);

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-5">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">{title}</h3>
      {children}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}

function StatPill({ label, value, sub, accent = 'teal' }: StatCardProps) {
  const accentMap: Record<string, string> = {
    teal:   'text-teal-400',
    blue:   'text-blue-400',
    purple: 'text-purple-400',
  };
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm p-5 flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold ${accentMap[accent] ?? accentMap['teal']}`}>{value}</span>
      {sub && <span className="text-xs text-gray-400 dark:text-gray-500">{sub}</span>}
    </div>
  );
}

export function RevenueIntelligenceSection() {
  const [data,    setData]    = useState<RevenueIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/analytics/revenue');
      const json = await res.json() as { data: RevenueIntelligence };
      if (!res.ok) throw new Error((json as unknown as { message?: string }).message ?? 'Failed to load revenue data');
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load revenue data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Revenue Intelligence</h2>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-teal-500" />
        </div>
      )}

      {data && (
        <>
          {/* KPI stat pills */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <StatPill
              label="Net Revenue Retention"
              value={`${data.nrr}%`}
              sub={data.nrr >= 100 ? 'Expansion MRR covering churn' : 'Below 100% — churn exceeds expansion'}
              accent={data.nrr >= 100 ? 'teal' : 'purple'}
            />
            <StatPill
              label="ARPU"
              value={fmtZAR(data.arpu_cents)}
              sub="Average revenue per active company"
              accent="blue"
            />
            <StatPill
              label="LTV Estimate"
              value={data.ltv_estimate_cents > 0 ? fmtZAR(data.ltv_estimate_cents) : 'N/A'}
              sub="ARPU / avg monthly churn rate"
              accent="purple"
            />
          </div>

          {/* Plan breakdown + Churn trend side by side */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
            <ChartCard title="MRR by Plan &amp; Billing Cycle">
              <PlanBreakdownChart data={data.plan_breakdown} />
            </ChartCard>
            <ChartCard title="Churn Rate Trend (6 months)">
              <ChurnTrendChart data={data.churn_trend} />
            </ChartCard>
          </div>

          {/* Cohort retention table */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Cohort Retention</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                % of each signup cohort still active at M0 / M1 / M2 / M3
              </p>
            </div>
            <CohortRetentionTable data={data.cohort_retention} />
          </div>
        </>
      )}
    </div>
  );
}
