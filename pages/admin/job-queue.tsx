/**
 * Admin — Background Job Queue
 * Monitor and manage all background jobs across the platform.
 * Route: /admin/job-queue
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { JobBulkActionsBar } from '@/components/admin/job-queue/JobBulkActionsBar';
import { JobTable } from '@/components/admin/job-queue/JobTable';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, RefreshCw, Zap, Trash2 } from 'lucide-react';
import type { BackgroundJob } from '@/modules/accounting/services/jobQueueService';

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_TABS = ['all', 'pending', 'running', 'completed', 'failed'] as const;
interface BulkResult { processed: number; errors: string[] }

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function JobQueuePage() {
  const [jobs, setJobs]           = useState<BackgroundJob[]>([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [activeTab, setActiveTab] = useState<typeof STATUS_TABS[number]>('all');
  const [retrying, setRetrying]   = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [deletingOld, setDeletingOld] = useState(false);
  const [toastMsg, setToastMsg]       = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (activeTab !== 'all') params.set('status', activeTab);
      const res = await apiFetch(`/api/admin/job-queue?${params}`, { credentials: 'include' });
      const json = await res.json() as { data: { jobs: BackgroundJob[]; total: number } };
      setJobs(json.data?.jobs ?? []);
      setTotal(json.data?.total ?? 0);
      setLastRefresh(new Date());
      setSelectedIds(new Set());
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 10_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [load]);

  // ── Individual retry ──────────────────────────────────────────────────────
  const handleRetry = async (jobId: string) => {
    setRetrying(jobId);
    try {
      await apiFetch('/api/admin/job-queue', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ action: 'retry', jobId }),
      });
      await load();
    } finally { setRetrying(null); }
  };

  // ── Checkbox helpers ──────────────────────────────────────────────────────
  const toggleRow = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => {
    setSelectedIds(selectedIds.size === jobs.length ? new Set() : new Set(jobs.map(j => j.id)));
  };

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const callBulk = async (action: 'retry' | 'cancel') => {
    const res = await apiFetch('/api/admin/job-queue/bulk-action', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
      body: JSON.stringify({ action, ids: [...selectedIds] }),
    });
    return ((await res.json()) as { data: BulkResult }).data;
  };

  const handleBulkRetry = async () => {
    setBulkLoading(true);
    try {
      const r = await callBulk('retry');
      showToast(`Retried ${r.processed} job(s)${r.errors.length ? ` (${r.errors.length} skipped)` : ''}`);
      await load();
    } finally { setBulkLoading(false); }
  };

  const handleBulkCancel = async () => {
    setBulkLoading(true);
    try {
      const r = await callBulk('cancel');
      showToast(`Cancelled ${r.processed} job(s)${r.errors.length ? ` (${r.errors.length} skipped)` : ''}`);
      await load();
    } finally { setBulkLoading(false); }
  };

  const handleDeleteOld = async () => {
    setDeletingOld(true);
    try {
      const res = await apiFetch('/api/admin/job-queue/bulk-action', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ action: 'delete_old', olderThanDays: 30 }),
      });
      const json = await res.json() as { data: { processed: number } };
      showToast(`Deleted ${json.data?.processed ?? 0} old job(s) (30d+)`);
      await load();
    } finally { setDeletingOld(false); }
  };

  // ── Tab counts ────────────────────────────────────────────────────────────
  const counts = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <AdminLayout title="Background Jobs">
      <div className="min-h-screen bg-gray-900">
        {toastMsg && (
          <div className="fixed top-4 right-4 z-50 px-4 py-3 bg-teal-700 text-white text-sm rounded-xl shadow-lg">
            {toastMsg}
          </div>
        )}

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
            <div className="flex items-center gap-2">
              <button
                onClick={handleDeleteOld} disabled={deletingOld}
                className="flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:text-red-300 border border-red-700/50 hover:border-red-600 rounded-lg transition-colors disabled:opacity-50"
                title="Delete completed/cancelled/failed jobs older than 30 days"
              >
                {deletingOld ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete Old Jobs (30d)
              </button>
              <button
                onClick={load} disabled={loading}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white border border-gray-600 rounded-lg transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>

          {/* Status Tabs */}
          <div className="flex gap-1 mt-4">
            {STATUS_TABS.map(tab => (
              <button
                key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm rounded-t-lg border-b-2 transition-colors capitalize ${
                  activeTab === tab ? 'text-blue-400 border-blue-400 bg-blue-500/5' : 'text-gray-400 border-transparent hover:text-white'
                }`}
              >
                {tab}
                {tab !== 'all' && counts[tab] != null && (
                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-300">{counts[tab]}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="p-6">
          {selectedIds.size > 0 && (
            <JobBulkActionsBar
              count={selectedIds.size} loading={bulkLoading}
              onRetry={handleBulkRetry} onCancel={handleBulkCancel}
              onClear={() => setSelectedIds(new Set())}
            />
          )}
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
              <JobTable
                jobs={jobs}
                selectedIds={selectedIds}
                retrying={retrying}
                onToggleRow={toggleRow}
                onToggleAll={toggleAll}
                onRetry={handleRetry}
              />
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
