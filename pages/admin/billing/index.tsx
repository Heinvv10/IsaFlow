/**
 * Admin — Billing Overview
 * MRR, ARR, subscription KPIs + recent subscriptions table.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { StatsCard } from '@/components/admin/StatsCard';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { AlertCircle, Loader2, ArrowRight, CreditCard, List, FileText } from 'lucide-react';
import Link from 'next/link';

interface BillingOverview {
  mrr_cents: number;
  arr_cents: number;
  total_subscriptions: number;
  active_subscriptions: number;
  past_due_count: number;
  trial_count: number;
  churn_rate_percent: number;
  arpu_cents: number;
  total_revenue_cents: number;
  outstanding_cents: number;
}

interface RecentSubscription {
  id: string;
  company_name: string;
  plan_name: string;
  status: string;
  billing_cycle: string;
  monthly_amount_cents: number;
  created_at: string;
}

const SUB_STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  past_due:  'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
  paused:    'bg-blue-500/10 text-blue-400',
};

export default function BillingOverviewPage() {
  const adminHref = useAdminHref();
  const [overview, setOverview]   = useState<BillingOverview | null>(null);
  const [recent, setRecent]       = useState<RecentSubscription[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ovRes, subRes] = await Promise.all([
        apiFetch('/api/admin/billing/overview'),
        apiFetch('/api/admin/billing/subscriptions?limit=10'),
      ]);
      const [ovJson, subJson] = await Promise.all([ovRes.json(), subRes.json()]);
      if (!ovRes.ok)  throw new Error(ovJson.message  || 'Failed to load billing overview');
      if (!subRes.ok) throw new Error(subJson.message || 'Failed to load subscriptions');
      setOverview(ovJson.data as BillingOverview);
      setRecent((subJson.data?.items ?? subJson.data ?? []) as RecentSubscription[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <AdminLayout title="Billing Overview">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {loading && !overview && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {overview && (
        <>
          {/* KPI Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-8">
            <StatsCard title="MRR"                   value={formatCurrency(overview.mrr_cents / 100)} />
            <StatsCard title="ARR"                   value={formatCurrency(overview.arr_cents / 100)} />
            <StatsCard title="Active Subscriptions"  value={overview.active_subscriptions} />
            <StatsCard title="Past Due"              value={overview.past_due_count} />
            <StatsCard title="Trials"                value={overview.trial_count} />
            <StatsCard title="Churn Rate"            value={`${overview.churn_rate_percent.toFixed(1)}%`} />
            <StatsCard title="ARPU"                  value={formatCurrency(overview.arpu_cents / 100)} />
            <StatsCard title="Total Revenue"         value={formatCurrency(overview.total_revenue_cents / 100)} />
            <StatsCard title="Outstanding"           value={formatCurrency(overview.outstanding_cents / 100)} />
          </div>

          {/* Quick Links */}
          <div className="flex gap-3 flex-wrap mb-8">
            <Link
              href={adminHref('/admin/billing/plans')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <CreditCard className="w-4 h-4" /> Manage Plans <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href={adminHref('/admin/billing/subscriptions')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <List className="w-4 h-4" /> View Subscriptions <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href={adminHref('/admin/billing/invoices')}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <FileText className="w-4 h-4" /> View Invoices <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {/* Recent Subscriptions */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Subscriptions</h2>
              <Link
                href={adminHref('/admin/billing/subscriptions')}
                className="text-xs text-teal-500 hover:text-teal-400 transition-colors"
              >
                View all
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                    <th className="px-5 py-3 font-medium">Company</th>
                    <th className="px-5 py-3 font-medium">Plan</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Billing Cycle</th>
                    <th className="px-5 py-3 font-medium">Amount</th>
                    <th className="px-5 py-3 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-gray-400">No subscriptions found</td>
                    </tr>
                  )}
                  {recent.map(sub => (
                    <tr key={sub.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                      <td className="px-5 py-3 font-medium text-gray-900 dark:text-white">{sub.company_name}</td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{sub.plan_name}</td>
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${SUB_STATUS_BADGE[sub.status] ?? 'bg-gray-500/10 text-gray-500'}`}>
                          {sub.status.replaceAll('_', ' ')}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300 capitalize">{sub.billing_cycle}</td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{formatCurrency(sub.monthly_amount_cents / 100)}</td>
                      <td className="px-5 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(sub.created_at)}</td>
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
