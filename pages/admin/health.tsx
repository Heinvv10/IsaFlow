/**
 * Admin System Health Page
 * /admin/health — real-time monitoring: DB, job queue, email, sessions, trials, errors
 * Auto-refreshes every 30 seconds.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  Activity, Database, Zap, Mail, Users, Clock,
  RefreshCw, AlertTriangle, Loader2,
} from 'lucide-react';
import {
  MetricCard, Stat, StatusBadge, OverallStatusBar,
  type SystemHealthData, type StatusLevel, type RecentError,
} from '@/components/admin/HealthWidgets';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function fmtTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SystemHealthPage() {
  const [data, setData]             = useState<SystemHealthData | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState('');
  const timerRef                    = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    else if (!data) setLoading(true);
    setError('');
    try {
      const res  = await apiFetch('/api/admin/health');
      const json = await res.json() as { data: SystemHealthData; message?: string };
      if (!res.ok) throw new Error(json.message ?? 'Failed to load health data');
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [data]);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => { void load(); }, 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dbStatus:    StatusLevel = !data ? 'ok' : data.db.status === 'error' ? 'error' : data.db.latency_ms > 1000 ? 'warn' : 'ok';
  const jobStatus:   StatusLevel = !data ? 'ok' : data.job_queue.failed > 50 ? 'error' : data.job_queue.failed > 10 ? 'warn' : 'ok';
  const emailStatus: StatusLevel = !data ? 'ok' : data.email.success_rate_percent < 80 ? 'error' : data.email.success_rate_percent < 95 ? 'warn' : 'ok';

  return (
    <AdminLayout title="System Health">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-teal-500" />
            System Health
          </h1>
          {data && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Last checked at {fmtTime(data.checked_at)} — auto-refreshes every 30s
            </p>
          )}
        </div>
        <button
          onClick={() => void load(true)}
          disabled={refreshing || loading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-teal-500" />
        </div>
      )}

      {data && (
        <>
          <OverallStatusBar status={data.overall_status} />

          {/* Metric cards grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
            {/* Database */}
            <MetricCard title="Database" icon={Database} status={dbStatus}>
              <div className="grid grid-cols-2 gap-3">
                <Stat label="Status"     value={<StatusBadge level={dbStatus} label={data.db.status === 'ok' ? 'Connected' : 'Error'} />} />
                <Stat label="Query (ms)" value={data.db.latency_ms} />
                <Stat label="DB Size"    value={`${data.db.size_mb} MB`} />
                {data.db.error && (
                  <p className="col-span-2 text-xs text-red-400 mt-1 truncate">{data.db.error}</p>
                )}
              </div>
            </MetricCard>

            {/* Job Queue */}
            <MetricCard title="Job Queue" icon={Zap} status={jobStatus} linkHref="/admin/job-queue" linkLabel="View job queue">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Pending" value={data.job_queue.pending} />
                <Stat label="Running" value={data.job_queue.running} />
                <Stat label="Failed"  value={<span className={data.job_queue.failed > 0 ? 'text-red-400' : ''}>{data.job_queue.failed}</span>} />
              </div>
              {data.job_queue.oldest_pending_age_minutes != null && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
                  Oldest pending: <span className="font-medium text-gray-700 dark:text-gray-300">{data.job_queue.oldest_pending_age_minutes}m ago</span>
                </p>
              )}
            </MetricCard>

            {/* Email Delivery */}
            <MetricCard title="Email Delivery (24h)" icon={Mail} status={emailStatus} linkHref="/admin/email-log" linkLabel="View email log">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Sent"    value={data.email.sent_24h} />
                <Stat label="Failed"  value={<span className={data.email.failed_24h > 0 ? 'text-red-400' : ''}>{data.email.failed_24h}</span>} />
                <Stat label="Success" value={`${data.email.success_rate_percent}%`} />
              </div>
            </MetricCard>

            {/* Active Sessions */}
            <MetricCard title="Active Users (24h)" icon={Users} status="ok">
              <Stat label="Sessions" value={data.active_sessions_24h} />
            </MetricCard>

            {/* Trials */}
            <MetricCard title="Trials" icon={Clock} status={data.trials.expiring_in_7d > 5 ? 'warn' : 'ok'} linkHref="/admin/trials" linkLabel="View all trials">
              <Stat
                label="Expiring in 7 days"
                value={<span className={data.trials.expiring_in_7d > 0 ? 'text-yellow-400' : ''}>{data.trials.expiring_in_7d}</span>}
              />
            </MetricCard>
          </div>

          {/* Recent Error Log */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-500" />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Error Events</h2>
              <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">Last 10 from audit log</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-3 font-medium">Action</th>
                    <th className="px-5 py-3 font-medium">Target</th>
                    <th className="px-5 py-3 font-medium">Details</th>
                    <th className="px-5 py-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_errors.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-8 text-center text-gray-600 dark:text-gray-400 text-sm">
                        No error events found — all clear
                      </td>
                    </tr>
                  )}
                  {data.recent_errors.map((row: RecentError) => (
                    <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40">
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400">{row.action}</span>
                      </td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{row.target_type}</td>
                      <td className="px-5 py-3 text-gray-500 dark:text-gray-400 max-w-xs truncate text-xs font-mono">
                        {Object.keys(row.details).length > 0 ? JSON.stringify(row.details) : '—'}
                      </td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtRelative(row.created_at)}</td>
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
