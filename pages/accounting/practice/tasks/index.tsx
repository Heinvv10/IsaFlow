/**
 * Practice Task Inbox
 * Route: /accounting/practice/tasks
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { CheckSquare, Loader2, AlertCircle, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useAuth } from '@/contexts/AuthContext';
import type { PracticeTask, PracticeTaskInput } from '@/modules/accounting/services/practice/practiceTaskService';

interface JobOption { id: string; title: string }
type TabKey = 'my' | 'overdue' | 'upcoming' | 'all' | 'unassigned';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'my', label: 'My Tasks' }, { key: 'overdue', label: 'Overdue' },
  { key: 'upcoming', label: 'Upcoming' }, { key: 'all', label: 'All' },
  { key: 'unassigned', label: 'Unassigned' },
];
const TASK_STATUS: Record<PracticeTask['status'], { label: string; cls: string }> = {
  pending:     { label: 'Pending',     cls: 'bg-slate-100 text-slate-700 border-slate-300' },
  in_progress: { label: 'In Progress', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
  done:        { label: 'Done',        cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  cancelled:   { label: 'Cancelled',   cls: 'bg-rose-100 text-rose-800 border-rose-300' },
};
const PRI_DOT: Record<PracticeTask['priority'], string> = {
  low: 'bg-slate-400', normal: 'bg-blue-400', high: 'bg-amber-400', urgent: 'bg-rose-500',
};
const PRI_LBL: Record<PracticeTask['priority'], string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const NEXT_STATUS: Record<PracticeTask['status'], PracticeTask['status'][]> = {
  pending: ['in_progress', 'done', 'cancelled'], in_progress: ['pending', 'done', 'cancelled'], done: [], cancelled: [],
};

function TaskBadge({ status }: { status: PracticeTask['status'] }) {
  const s = TASK_STATUS[status];
  return <span className={`inline-block px-2 py-0.5 text-xs font-medium border rounded ${s.cls}`}>{s.label}</span>;
}
function isOverdue(t: PracticeTask) {
  return !!t.dueDate && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.dueDate) < new Date();
}
function filterTab(tasks: PracticeTask[], tab: TabKey, uid?: string): PracticeTask[] {
  const f14 = new Date(); f14.setDate(f14.getDate() + 14);
  if (tab === 'my')        return tasks.filter(t => t.assignedTo === uid && (t.status === 'pending' || t.status === 'in_progress'));
  if (tab === 'overdue')   return tasks.filter(isOverdue);
  if (tab === 'upcoming')  return tasks.filter(t => t.status === 'pending' && !!t.dueDate && new Date(t.dueDate) <= f14 && !isOverdue(t));
  if (tab === 'unassigned')return tasks.filter(t => !t.assignedTo && t.status !== 'done' && t.status !== 'cancelled');
  return tasks;
}

export default function PracticeTasksPage() {
  const router = useRouter();
  const { user } = useAuth();
  const tab = ((router.query.tab as TabKey | undefined) ?? 'my');

  const [tasks,     setTasks]    = useState<PracticeTask[]>([]);
  const [jobs,      setJobs]     = useState<JobOption[]>([]);
  const [loading,   setLoading]  = useState(true);
  const [error,     setError]    = useState('');
  const [toast,     setToast]    = useState('');
  const [popover,   setPopover]  = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const [qaTitle,    setQaTitle]    = useState('');
  const [qaAssigned, setQaAssigned] = useState('');
  const [qaDue,      setQaDue]      = useState('');
  const [qaPriority, setQaPriority] = useState<PracticeTask['priority']>('normal');
  const [qaJob,      setQaJob]      = useState('');
  const [qaAdding,   setQaAdding]   = useState(false);

  const loadTasks = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiFetch('/api/accounting/practice/tasks');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { data?: { tasks: PracticeTask[] }; tasks?: PracticeTask[] };
      setTasks(((j.data ?? j) as { tasks: PracticeTask[] }).tasks ?? []);
    } catch { setError('Failed to load tasks'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadTasks(); }, [loadTasks]);
  useEffect(() => {
    apiFetch('/api/accounting/practice/jobs').then(async r => {
      if (!r.ok) return;
      const j = await r.json() as { data?: { jobs: JobOption[] }; jobs?: JobOption[] };
      setJobs(((j.data ?? j) as { jobs: JobOption[] }).jobs ?? []);
    }).catch(() => { /* non-critical */ });
  }, []);
  useEffect(() => {
    if (!popover) return;
    function onOut(e: MouseEvent) { if (popRef.current && !popRef.current.contains(e.target as Node)) setPopover(null); }
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [popover]);

  function flash(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  async function doTransition(id: string, ns: PracticeTask['status']) {
    setPopover(null);
    try {
      const r = await apiFetch('/api/accounting/practice/tasks/transition', { method: 'POST', body: JSON.stringify({ id, newStatus: ns }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? `HTTP ${r.status}`); }
      flash('Status updated'); await loadTasks();
    } catch (e) { setError(e instanceof Error ? e.message : 'Transition failed'); }
  }

  async function doAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!qaTitle.trim()) return;
    setQaAdding(true);
    try {
      const body: PracticeTaskInput = { title: qaTitle.trim(), assignedTo: qaAssigned.trim() || null, dueDate: qaDue || null, priority: qaPriority, jobId: qaJob || null };
      const r = await apiFetch('/api/accounting/practice/tasks', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? `HTTP ${r.status}`); }
      setQaTitle(''); setQaAssigned(''); setQaDue(''); setQaPriority('normal'); setQaJob('');
      flash('Task added'); await loadTasks();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to add task'); }
    finally { setQaAdding(false); }
  }

  function goTab(t: TabKey) { void router.push({ query: { ...router.query, tab: t } }, undefined, { shallow: true }); }

  const visible = filterTab(tasks, tab, user?.id);
  const inputCls = 'py-1.5 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500 placeholder:text-[var(--ff-text-tertiary)]';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><CheckSquare className="h-5 w-5 text-teal-400" /></div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Tasks</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Your task inbox</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-6">
          {error && <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm"><AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}
          {toast && <div className="p-3 mb-4 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 text-sm">{toast}</div>}

          <div className="flex items-center gap-2 mb-6 flex-wrap">
            {TABS.map(t => (
              <button key={t.key} onClick={() => goTab(t.key)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${tab === t.key ? 'bg-teal-600 text-white' : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-primary)]'}`}>
                {t.label}
              </button>
            ))}
            {!loading && <span className="ml-auto text-sm text-[var(--ff-text-secondary)]">{visible.length} task{visible.length !== 1 ? 's' : ''}</span>}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16">
              <CheckSquare className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No tasks found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Use the form below to add a task</p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)] mb-24">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    {['Title', 'Job', 'Assigned To', 'Due Date', 'Priority', 'Status'].map(h => (
                      <th key={h} className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((task, i) => {
                    const ov = isOverdue(task);
                    const nx = NEXT_STATUS[task.status];
                    return (
                      <tr key={task.id} className={`border-b border-[var(--ff-border-primary)] last:border-0 transition-colors ${i % 2 ? 'bg-[var(--ff-bg-secondary)]/40' : ''} hover:bg-teal-500/[0.04]`}>
                        <td className="py-3 px-4 font-medium text-[var(--ff-text-primary)] max-w-[220px] truncate">{task.title}</td>
                        <td className="py-3 px-4 text-[var(--ff-text-secondary)]">
                          {task.jobId ? <Link href={`/accounting/practice/jobs/${task.jobId}`} className="text-teal-400 hover:text-teal-300">{task.jobTitle ?? task.jobId.slice(0, 8)}</Link> : '—'}
                        </td>
                        <td className="py-3 px-4 text-[var(--ff-text-secondary)] font-mono text-xs">
                          {task.assignedTo ? task.assignedTo.slice(0, 8) + '…' : <span className="text-[var(--ff-text-tertiary)]">Unassigned</span>}
                        </td>
                        <td className={`py-3 px-4 ${ov ? 'text-amber-400 font-medium' : 'text-[var(--ff-text-secondary)]'}`}>{task.dueDate ?? '—'}</td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${PRI_DOT[task.priority]}`} />
                            <span className="text-[var(--ff-text-secondary)]">{PRI_LBL[task.priority]}</span>
                          </div>
                        </td>
                        <td className="py-3 px-4 relative">
                          <button onClick={() => setPopover(popover === task.id ? null : task.id)} disabled={nx.length === 0}>
                            <TaskBadge status={task.status} />
                          </button>
                          {popover === task.id && nx.length > 0 && (
                            <div ref={popRef} className="absolute z-20 mt-1 left-0 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded-lg shadow-lg p-1 min-w-[130px]">
                              {nx.map(ns => (
                                <button key={ns} onClick={() => void doTransition(task.id, ns)}
                                  className="block w-full text-left px-3 py-1.5 text-xs rounded hover:bg-teal-500/10 text-[var(--ff-text-primary)] transition-colors">
                                  → {TASK_STATUS[ns].label}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="fixed bottom-0 left-0 right-0 bg-[var(--ff-bg-secondary)] border-t border-[var(--ff-border-primary)] px-6 py-3 z-10">
          <form onSubmit={e => void doAdd(e)} className="flex items-center gap-2 flex-wrap">
            <input value={qaTitle} onChange={e => setQaTitle(e.target.value)} required placeholder="Task title…" className={`flex-1 min-w-[160px] ${inputCls}`} />
            <input value={qaAssigned} onChange={e => setQaAssigned(e.target.value)} placeholder="Assigned to (user id)" className={`w-40 ${inputCls}`} />
            <input type="date" value={qaDue} onChange={e => setQaDue(e.target.value)} className={inputCls} />
            <select value={qaPriority} onChange={e => setQaPriority(e.target.value as PracticeTask['priority'])} className={inputCls}>
              {(['low', 'normal', 'high', 'urgent'] as const).map(p => <option key={p} value={p}>{PRI_LBL[p]}</option>)}
            </select>
            <select value={qaJob} onChange={e => setQaJob(e.target.value)} className={inputCls}>
              <option value="">No Job</option>
              {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
            </select>
            <button type="submit" disabled={qaAdding || !qaTitle.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {qaAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
            </button>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
