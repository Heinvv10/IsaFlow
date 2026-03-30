/**
 * Admin Usage Analytics — DAU/WAU/MAU, feature adoption, revenue by plan, churn signals.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { StatsCard } from '@/components/admin/StatsCard';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2 } from 'lucide-react';

interface UsageAnalytics {
  dau: number;
  wau: number;
  mau: number;
  stickiness_percent: number;
  top_pages: Array<{ path: string; views: number }>;
  feature_adoption: Array<{ feature: string; adoption_percent: number; user_count: number }>;
  revenue_by_plan: Array<{ plan_name: string; mrr_cents: number; company_count: number }>;
  churn_signals: Array<{ company_id: string; company_name: string; days_inactive: number; last_login: string | null }>;
}

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

function fmtDate(dateStr: string | null) {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleDateString('en-ZA');
}

export default function AdminAnalytics() {
  const [data, setData]       = useState<UsageAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/analytics/usage');
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load analytics');
      setData(json.data as UsageAnalytics);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <AdminLayout title="Usage Analytics">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {data && (
        <>
          {/* Engagement Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatsCard title="DAU"          value={data.dau} subtitle="daily active users" />
            <StatsCard title="WAU"          value={data.wau} subtitle="weekly active users" />
            <StatsCard title="MAU"          value={data.mau} subtitle="monthly active users" />
            <StatsCard title="Stickiness"   value={`${data.stickiness_percent}%`} subtitle="DAU / MAU" />
          </div>

          {/* Revenue by Plan */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-6">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Revenue by Plan</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-3 font-medium">Plan</th>
                    <th className="px-5 py-3 font-medium text-right">MRR</th>
                    <th className="px-5 py-3 font-medium text-right">Companies</th>
                  </tr>
                </thead>
                <tbody>
                  {data.revenue_by_plan.length === 0 && (
                    <tr><td colSpan={3} className="px-5 py-8 text-center text-gray-400">No plan data</td></tr>
                  )}
                  {data.revenue_by_plan.map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-5 py-3 font-medium text-gray-800 dark:text-gray-200">{row.plan_name}</td>
                      <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-300">{fmtZAR(row.mrr_cents)}</td>
                      <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-400">{row.company_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Feature Adoption */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-6">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Feature Adoption</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-3 font-medium">Feature</th>
                    <th className="px-5 py-3 font-medium text-right">Adoption</th>
                    <th className="px-5 py-3 font-medium text-right">Companies</th>
                  </tr>
                </thead>
                <tbody>
                  {data.feature_adoption.length === 0 && (
                    <tr><td colSpan={3} className="px-5 py-8 text-center text-gray-400">No feature data</td></tr>
                  )}
                  {data.feature_adoption.map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-5 py-3 text-gray-800 dark:text-gray-200">{row.feature}</td>
                      <td className="px-5 py-3 text-right">
                        <span className="inline-flex items-center gap-1">
                          <span className="text-gray-700 dark:text-gray-300 font-medium">{row.adoption_percent}%</span>
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-400">{row.user_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Churn Signals */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Churn Signals</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Companies with no user login in 14+ days</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-3 font-medium">Company</th>
                    <th className="px-5 py-3 font-medium text-right">Days Inactive</th>
                    <th className="px-5 py-3 font-medium text-right">Last Login</th>
                  </tr>
                </thead>
                <tbody>
                  {data.churn_signals.length === 0 && (
                    <tr><td colSpan={3} className="px-5 py-8 text-center text-gray-400">No churn signals — great!</td></tr>
                  )}
                  {data.churn_signals.map((row, i) => (
                    <tr
                      key={i}
                      className={[
                        'border-b border-gray-100 dark:border-gray-800 last:border-0',
                        row.days_inactive > 30
                          ? 'bg-red-50 dark:bg-red-900/10'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-800/40',
                      ].join(' ')}
                    >
                      <td className={[
                        'px-5 py-3 font-medium',
                        row.days_inactive > 30 ? 'text-red-700 dark:text-red-400' : 'text-gray-800 dark:text-gray-200',
                      ].join(' ')}>
                        {row.company_name}
                      </td>
                      <td className={[
                        'px-5 py-3 text-right font-semibold',
                        row.days_inactive > 30 ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400',
                      ].join(' ')}>
                        {row.days_inactive}d
                      </td>
                      <td className="px-5 py-3 text-right text-gray-500 dark:text-gray-400">
                        {fmtDate(row.last_login)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
