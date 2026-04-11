/**
 * Admin — Background Job Queue
 * Monitor and manage all background jobs across the platform.
 * Route: /admin/job-queue
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, RefreshCw, RotateCcw, Zap } from 'lucide-react';
import type { BackgroundJob } from '@/modules/accounting/services/jobQueueService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtDate = (d: string | Date | null) => {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
};

const fmtDuration = (start: string | Date | null, end: string | Date | null): string => {
  if (!start) return '—';
  const s = start instanceof Date ? start : new Date(start);
  const e = end ? (end instanceof Date ? end : new Date(end)) : new Date();
  const ms = e.getTime() - s.getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

const payloadSummary = (payload: Record<string, unknown>): string => {
  const keys = Object.keys(payload);
  if (keys.length === 0) return '{}';
  const preview = keys.slice(0, 3).map(k => `${k}: ${String(payload[k]).slice(0, 20)}`).join(', ');
  return keys.length > 3 ? `${preview} …` : preview;
};

const STATUS_TABS = ['all', 'pending', 'running', 'completed', 'failed'] as const;

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-amber-500/10 text-amber-400 border border-amber-500/30',
  running:   'bg-blue-500/10 text-blue-400 border border-blue-500/30',
  completed: 'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  failed:    'bg-red-500/10 text-red-400 border border-red-500/30',
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function JobQueuePage() {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<typeof STATUS_TABS[number]>('all');
  const [retrying, setRetrying] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (activeTab !== 'all') params.set('status', activeTab);
      const res = await apiFetch(`/api/admin/job-queue?${params}`, { credentials: 'include' });
      const json = await res.json();
      const data = json.data as { jobs: BackgroundJob[]; total: number };
      setJobs(data?.jobs ?? []);
      setTotal(data?.total ?? 0);
      setLastRefresh(new Date());
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  // Auto-refresh every 10s
  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [load]);

  const handleRetry = async (jobId: string) => {
    setRetrying(jobId);
    try {
      await apiFetch('/api/admin/job-queue', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry', jobId }),
      });
      await load();
    } finally {
      setRetrying(null);
    }
  };

  // Counts by status for tab badges
  const counts = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <AdminLayout title="Background Jobs">
      <div className="min-h-screen bg-gray-900">
        {/* Header */}
        <div className="border-b border-gray-700 bg-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Zap className="h-5 w-5 text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-white">Background Jobs</h1>
                <p className="text-sm text-gray-400">
                  {total} total jobs
                  {lastRefresh && ` · refreshed ${lastRefresh.toLocaleTimeString('en-ZA')}`}
                </p>
              </div>
            </div>
            <button
              onClick={load}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>

          {/* Status Tabs */}
          <div className="flex gap-1 mt-4">
            {STATUS_TABS.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm rounded-t-lg border-b-2 transition-colors capitalize ${
                  activeTab === tab
                    ? 'text-blue-400 border-blue-400 bg-blue-500/5'
                    : 'text-gray-400 border-transparent hover:text-white'
                }`}
              >
                {tab}
                {tab !== 'all' && counts[tab] != null && (
                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-300">
                    {counts[tab]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="p-6">
          <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
            {loading && jobs.length === 0 ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <Zap className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>No jobs found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Job Type</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Company</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Payload</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Status</th>
                      <th className="text-center px-4 py-3 text-xs font-medium text-gray-400">Attempts</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Created</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Duration</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-gray-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {jobs.map(job => (
                      <tr key={job.id} className="hover:bg-gray-700/30 transition-colors">
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-blue-300">{job.job_type}</span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">
                          {job.company_id ? job.company_id.slice(0, 8) + '…' : <span className="italic">system</span>}
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <span className="text-xs text-gray-300 font-mono truncate block" title={JSON.stringify(job.payload)}>
                            {payloadSummary(job.payload ?? {})}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 text-xs rounded-full capitalize ${STATUS_COLORS[job.status] ?? ''}`}>
                            {job.status}
                          </span>
                          {job.error_message && (
                            <p className="text-xs text-red-400 mt-0.5 max-w-xs truncate" title={job.error_message}>
                              {job.error_message}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-gray-300">
                          {job.attempts}/{job.max_attempts}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                          {fmtDate(job.created_at)}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                          {fmtDuration(job.started_at, job.completed_at)}
                        </td>
                        <td className="px-4 py-3">
                          {job.status === 'failed' && (
                            <button
                              disabled={retrying === job.id}
                              onClick={() => handleRetry(job.id)}
                              className="flex items-center gap-1 text-xs px-2 py-1 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 rounded transition-colors disabled:opacity-50"
                            >
                              {retrying === job.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <RotateCcw className="h-3 w-3" />
                              }
                              Retry
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
