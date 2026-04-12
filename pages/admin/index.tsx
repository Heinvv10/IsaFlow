/**
 * Admin Dashboard — KPI stats + recent activity feed.
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { StatsCard } from '@/components/admin/StatsCard';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { AlertCircle, Building2, Users, ArrowRight, Loader2, Activity, Clock } from 'lucide-react';
import Link from 'next/link';

interface TrialRow {
  id: string;
  name: string;
  trial_ends_at: string;
  user_count: number;
  days_left: number;
  status: string;
}

interface ActivityRow {
  id: string;
  type: string;
  description: string;
  user_name: string;
  company_name: string;
  created_at: string;
}

interface DashboardStats {
  total_companies: number;
  active_companies: number;
  total_users: number;
  active_users_30d: number;
  mrr_cents: number;
  arr_cents: number;
  new_signups_30d: number;
  recent_activity: ActivityRow[];
}

interface PlatformHealth {
  active_users_24h: number;
  active_users_7d: number;
  active_users_30d: number;
  db_size_mb: number;
  error_rate_percent: number;
}

function fmtRelative(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function trialDaysBadge(days: number) {
  if (days <= 0) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-700 text-gray-300">Expired</span>;
  if (days <= 2) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/20 text-red-400">{days}d</span>;
  if (days <= 5) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/20 text-orange-400">{days}d</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400">{days}d</span>;
}

function fmtTrialDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function AdminDashboard() {
  const adminHref = useAdminHref();
  const [stats, setStats]               = useState<DashboardStats | null>(null);
  const [health, setHealth]             = useState<PlatformHealth | null>(null);
  const [trials, setTrials]             = useState<TrialRow[]>([]);
  const [extendingId, setExtendingId]   = useState<string | null>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, healthRes, trialsRes] = await Promise.all([
        apiFetch('/api/admin/dashboard-stats'),
        apiFetch('/api/admin/analytics/health'),
        apiFetch('/api/admin/trials?within=7'),
      ]);
      const statsJson  = await statsRes.json();
      const healthJson = await healthRes.json();
      const trialsJson = await trialsRes.json();
      if (!statsRes.ok) throw new Error(statsJson.message || 'Failed to load dashboard');
      setStats(statsJson.data as DashboardStats);
      if (healthRes.ok) setHealth(healthJson.data as PlatformHealth);
      if (trialsRes.ok) setTrials((trialsJson.data ?? []) as TrialRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  const extendTrial = useCallback(async (companyId: string) => {
    setExtendingId(companyId);
    try {
      await apiFetch('/api/admin/trials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ company_id: companyId, days: 7 }),
      });
      await load();
    } finally {
      setExtendingId(null);
    }
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AdminLayout title="Admin Dashboard">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading && !stats && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {stats && (
        <>
          {/* KPI Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
            <StatsCard title="Total Companies"       value={stats.total_companies} />
            <StatsCard title="Active Companies"      value={stats.active_companies} />
            <StatsCard title="Total Users"           value={stats.total_users} />
            <StatsCard title="Active Users (30d)"    value={stats.active_users_30d} />
            <StatsCard title="MRR"                   value={formatCurrency(stats.mrr_cents / 100)} />
            <StatsCard title="New Signups (30d)"     value={stats.new_signups_30d} />
          </div>

          {/* Platform Health */}
          {health && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-6">
              <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-teal-500" />
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Platform Health</h2>
                </div>
                <Link href={adminHref('/admin/analytics')} className="text-xs text-teal-500 hover:text-teal-400 font-medium">
                  View Full Analytics
                </Link>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-gray-200 dark:bg-gray-700">
                {[
                  { label: 'Active (24h)',  value: health.active_users_24h },
                  { label: 'Active (7d)',   value: health.active_users_7d },
                  { label: 'Active (30d)',  value: health.active_users_30d },
                  { label: 'DB Size',       value: `${health.db_size_mb} MB` },
                  { label: 'Error Rate',    value: `${health.error_rate_percent}%` },
                ].map((item) => (
                  <div key={item.label} className="bg-white dark:bg-gray-900 px-5 py-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wider mb-1">{item.label}</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white">{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-8">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Activity</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-3 font-medium">Type</th>
                    <th className="px-5 py-3 font-medium">Description</th>
                    <th className="px-5 py-3 font-medium">User</th>
                    <th className="px-5 py-3 font-medium">Company</th>
                    <th className="px-5 py-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {(stats.recent_activity ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-gray-400 text-sm">
                        No recent activity
                      </td>
                    </tr>
                  )}
                  {(stats.recent_activity ?? []).map((row) => (
                    <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                          {row.type}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-gray-700 dark:text-gray-200 max-w-xs truncate">{row.description}</td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{row.user_name}</td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{row.company_name}</td>
                      <td className="px-5 py-3 text-gray-400 whitespace-nowrap">{fmtRelative(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Trials Expiring Soon */}
      {trials.length > 0 && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-8">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-yellow-500" />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Trials Expiring Soon</h2>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-500/20 text-yellow-400">{trials.length}</span>
            </div>
            <Link href={adminHref('/admin/trials')} className="text-xs text-teal-500 hover:text-teal-400 font-medium">
              View All Trials
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="px-5 py-3 font-medium">Company</th>
                  <th className="px-5 py-3 font-medium">Trial Ends</th>
                  <th className="px-5 py-3 font-medium">Users</th>
                  <th className="px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {trials.map((trial) => (
                  <tr key={trial.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                    <td className="px-5 py-3 font-medium text-gray-900 dark:text-white">{trial.name}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtTrialDate(trial.trial_ends_at)}</span>
                        {trialDaysBadge(trial.days_left)}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{trial.user_count}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => void extendTrial(trial.id)}
                          disabled={extendingId === trial.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-teal-600/20 hover:bg-teal-600/40 text-teal-400 rounded-md transition-colors disabled:opacity-40"
                        >
                          {extendingId === trial.id && <Loader2 className="w-3 h-3 animate-spin" />}
                          +7 days
                        </button>
                        <Link
                          href={adminHref(`/admin/companies/${trial.id}`)}
                          className="px-2.5 py-1 text-xs bg-gray-700/40 hover:bg-gray-700/70 text-gray-300 rounded-md transition-colors"
                        >
                          Upgrade
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex gap-3 flex-wrap">
        <Link
          href={adminHref('/admin/companies')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Building2 className="w-4 h-4" /> Manage Companies <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          href={adminHref('/admin/users')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Users className="w-4 h-4" /> Manage Users <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    </AdminLayout>
  );
}
