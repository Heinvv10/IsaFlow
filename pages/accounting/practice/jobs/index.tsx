/**
 * Practice Jobs List Page
 * List view + Kanban toggle with status/client filters.
 * Route: /accounting/practice/jobs
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Briefcase, Loader2, AlertCircle, Plus, List, Columns } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { JobStatusBadge } from '@/components/practice/JobStatusBadge';
import { KanbanBoard } from '@/components/practice/KanbanBoard';
import type { PracticeJob } from '@/modules/accounting/services/practice/practiceJobService';

type StatusFilter = 'all' | PracticeJob['status'];

interface PracticeClientOption {
  id: string;
  legalName: string;
}

const PRIORITY_DOT: Record<PracticeJob['priority'], string> = {
  low: 'bg-slate-400', normal: 'bg-blue-400', high: 'bg-amber-400', urgent: 'bg-rose-500',
};

const PRIORITY_LABEL: Record<PracticeJob['priority'], string> = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
};

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'new', label: 'New' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'In Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'billed', label: 'Billed' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
];

function isOverdue(job: PracticeJob): boolean {
  if (!job.dueDate) return false;
  if (job.status === 'complete' || job.status === 'cancelled') return false;
  return new Date(job.dueDate) < new Date();
}

export default function PracticeJobsPage() {
  const router = useRouter();
  const view = router.query.view === 'kanban' ? 'kanban' : 'list';

  const [jobs, setJobs] = useState<PracticeJob[]>([]);
  const [clients, setClients] = useState<PracticeClientOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [clientFilter, setClientFilter] = useState('');

  const loadJobs = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (clientFilter) params.set('practiceClientId', clientFilter);
      const res = await apiFetch(`/api/accounting/practice/jobs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: { jobs: PracticeJob[] }; jobs?: PracticeJob[] };
      const payload = json.data ?? json;
      setJobs((payload as { jobs: PracticeJob[] }).jobs ?? []);
    } catch {
      setError('Failed to load jobs');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, clientFilter]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    async function loadClients() {
      try {
        const res = await apiFetch('/api/accounting/practice/clients?status=active');
        if (!res.ok) return;
        const json = await res.json() as { data?: PracticeClientOption[]; } | PracticeClientOption[];
        const arr = (Array.isArray(json) ? json : (json as { data?: PracticeClientOption[] }).data) ?? [];
        setClients(arr as PracticeClientOption[]);
      } catch { /* non-critical */ }
    }
    void loadClients();
  }, []);

  async function handleTransition(jobId: string, newStatus: PracticeJob['status']) {
    setError('');
    try {
      const res = await apiFetch('/api/accounting/practice/jobs/transition', {
        method: 'POST',
        body: JSON.stringify({ id: jobId, newStatus }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setToast('Status updated');
      setTimeout(() => setToast(''), 3000);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to transition job');
    }
  }

  function setView(v: 'list' | 'kanban') {
    void router.push({ query: { ...router.query, view: v } }, undefined, { shallow: true });
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Briefcase className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Jobs</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Practice job management</p>
              </div>
            </div>
            <Link
              href="/accounting/practice/jobs/new"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Job
            </Link>
          </div>
        </div>

        <div className="px-6 py-6">
          {error && (
            <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {toast && (
            <div className="p-3 mb-4 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 text-sm">
              {toast}
            </div>
          )}

          {/* Filters + view toggle */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              className="py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">All Clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.legalName}</option>
              ))}
            </select>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {jobs.length} job{jobs.length !== 1 ? 's' : ''}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] p-1">
              <button
                onClick={() => setView('list')}
                className={`p-1.5 rounded transition-colors ${view === 'list' ? 'bg-teal-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}
                title="List view"
              >
                <List className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView('kanban')}
                className={`p-1.5 rounded transition-colors ${view === 'kanban' ? 'bg-teal-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}
                title="Kanban view"
              >
                <Columns className="h-4 w-4" />
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-16">
              <Briefcase className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No jobs found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Try adjusting your filters or add a new job</p>
            </div>
          ) : view === 'kanban' ? (
            <KanbanBoard
              jobs={jobs}
              onTransition={handleTransition}
              onOpenJob={(id) => void router.push(`/accounting/practice/jobs/${id}`)}
            />
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Client</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Title</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Priority</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Due Date</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Status</th>
                    <th className="py-3 px-4" />
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const overdue = isOverdue(job);
                    return (
                      <tr
                        key={job.id}
                        className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-teal-500/[0.04] transition-colors"
                      >
                        <td className="py-3 px-4 text-[var(--ff-text-secondary)]">
                          {job.practiceClientName ?? '—'}
                        </td>
                        <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)]">{job.title}</td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[job.priority]}`} />
                            <span className="text-[var(--ff-text-secondary)]">{PRIORITY_LABEL[job.priority]}</span>
                          </div>
                        </td>
                        <td className={`py-3 px-4 ${overdue ? 'text-amber-400 font-medium' : 'text-[var(--ff-text-secondary)]'}`}>
                          {job.dueDate ?? '—'}
                        </td>
                        <td className="py-3 px-4">
                          <JobStatusBadge status={job.status} />
                        </td>
                        <td className="py-3 px-4 text-right">
                          <Link
                            href={`/accounting/practice/jobs/${job.id}`}
                            className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
                          >
                            View →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
