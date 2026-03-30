/**
 * Admin Dashboard — KPI stats + recent activity feed.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { StatsCard } from '@/components/admin/StatsCard';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Building2, Users, ArrowRight, Loader2, Activity } from 'lucide-react';

interface DashboardStats {
  totalCompanies: number;
  activeCompanies30d: number;
  totalUsers: number;
  activeUsers30d: number;
  mrrCents: number;
  newSignups30d: number;
}

interface ActivityRow {
  type: string;
  description: string;
  user: string;
  company: string;
  createdAt: string;
}

interface DashboardData {
  stats: DashboardStats;
  recentActivity: ActivityRow[];
}

interface PlatformHealth {
  active_users_24h: number;
  active_users_7d: number;
  active_users_30d: number;
  db_size_mb: number;
  error_rate_percent: number;
}

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
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

export default function AdminDashboard() {
  const router = useRouter();
  const [data, setData]           = useState<DashboardData | null>(null);
  const [health, setHealth]       = useState<PlatformHealth | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, healthRes] = await Promise.all([
        apiFetch('/api/admin/dashboard-stats'),
        apiFetch('/api/admin/analytics/health'),
      ]);
      const statsJson  = await statsRes.json();
      const healthJson = await healthRes.json();
      if (!statsRes.ok) throw new Error(statsJson.message || 'Failed to load dashboard');
      setData(statsJson.data as DashboardData);
      if (healthRes.ok) setHealth(healthJson.data as PlatformHealth);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const stats = data?.stats;

  return (
    <AdminLayout title="Admin Dashboard">
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

      {stats && (
        <>
          {/* KPI Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
            <StatsCard title="Total Companies"       value={stats.totalCompanies} />
            <StatsCard title="Active (30d)"          value={stats.activeCompanies30d} subtitle="companies" />
            <StatsCard title="Total Users"           value={stats.totalUsers} />
            <StatsCard title="Active Users (30d)"    value={stats.activeUsers30d} />
            <StatsCard title="MRR"                   value={fmtZAR(stats.mrrCents)} />
            <StatsCard title="New Signups (30d)"     value={stats.newSignups30d} />
          </div>

          {/* Platform Health */}
          {health && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm mb-6">
              <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-teal-500" />
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Platform Health</h2>
                </div>
                <Link href="/admin/analytics" className="text-xs text-teal-500 hover:text-teal-400 font-medium">
                  View Full Analytics →
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
                  {(data?.recentActivity ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-gray-400 text-sm">
                        No recent activity
                      </td>
                    </tr>
                  )}
                  {(data?.recentActivity ?? []).map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                          {row.type}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-gray-700 dark:text-gray-200 max-w-xs truncate">{row.description}</td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{row.user}</td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{row.company}</td>
                      <td className="px-5 py-3 text-gray-400 whitespace-nowrap">{fmtRelative(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Quick Actions */}
      <div className="flex gap-3 flex-wrap">
        <button
          onClick={() => void router.push('/admin/companies')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Building2 className="w-4 h-4" /> Manage Companies <ArrowRight className="w-4 h-4" />
        </button>
        <button
          onClick={() => void router.push('/admin/users')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Users className="w-4 h-4" /> Manage Users <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </AdminLayout>
  );
}
