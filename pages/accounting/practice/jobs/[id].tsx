/**
 * Practice Job Detail Page — Tabs: Details | Tasks | Time
 * Route: /accounting/practice/jobs/[id]
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Briefcase, Loader2, AlertCircle, ArrowLeft, Clock } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { JobStatusBadge } from '@/components/practice/JobStatusBadge';
import type { PracticeJob } from '@/modules/accounting/services/practice/practiceJobService';
import type { PracticeTask } from '@/modules/accounting/services/practice/practiceTaskService';
import type { PracticeTimeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryService';

type Tab = 'details' | 'tasks' | 'time';

const ALLOWED: Record<PracticeJob['status'], PracticeJob['status'][]> = {
  new: ['in_progress', 'cancelled'], in_progress: ['review', 'cancelled'],
  review: ['in_progress', 'approved', 'cancelled'], approved: ['billed', 'cancelled'],
  billed: ['complete'], complete: [], cancelled: [],
};
const PDOT: Record<PracticeJob['priority'], string> = { low: 'bg-slate-400', normal: 'bg-blue-400', high: 'bg-amber-400', urgent: 'bg-rose-500' };
const PLBL: Record<PracticeJob['priority'], string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const SLBL: Record<PracticeJob['status'], string> = { new: 'New', in_progress: 'In Progress', review: 'In Review', approved: 'Approved', billed: 'Billed', complete: 'Complete', cancelled: 'Cancelled' };
const TSTYLE: Record<PracticeTask['status'], string> = { pending: 'bg-slate-100 text-slate-700', in_progress: 'bg-blue-100 text-blue-800', done: 'bg-green-100 text-green-700', cancelled: 'bg-rose-100 text-rose-700' };

const trunc = (s: string | null | undefined) => s ? s.slice(0, 8) : '—';
const fmt = (s: string | null | undefined) => s ?? '—';
const inp = 'w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] px-3 py-2 text-sm';
const TH = ({ h }: { h: string }) => <th className="text-left py-2 px-3 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">{h}</th>;

export default function JobDetailPage() {
  const router = useRouter();
  const jobId = typeof router.query.id === 'string' ? router.query.id : null;
  const [job, setJob] = useState<PracticeJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [banner, setBanner] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>('details');
  const [form, setForm] = useState<Partial<PracticeJob>>({});
  const [tasks, setTasks] = useState<PracticeTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [entries, setEntries] = useState<PracticeTimeEntry[]>([]);
  const [timeLoaded, setTimeLoaded] = useState(false);

  const loadJob = useCallback(async () => {
    if (!jobId) return;
    setLoading(true); setError('');
    try {
      const r = await apiFetch(`/api/accounting/practice/jobs/${jobId}`);
      if (r.status === 404) { setError('Job not found'); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { data?: PracticeJob } | PracticeJob;
      const job = ('data' in j ? j.data : j) as PracticeJob;
      setJob(job); setForm(job);
    } catch { setError('Failed to load job'); }
    finally { setLoading(false); }
  }, [jobId]);

  useEffect(() => { void loadJob(); }, [loadJob]);

  useEffect(() => {
    if (tab !== 'tasks' || tasksLoaded || !jobId) return;
    void apiFetch(`/api/accounting/practice/tasks?jobId=${jobId}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { data?: { tasks: PracticeTask[] }; tasks?: PracticeTask[] } | null) => {
        if (j) { const p = j.data ?? j; setTasks((p as { tasks: PracticeTask[] }).tasks ?? []); }
      })
      .finally(() => setTasksLoaded(true));
  }, [tab, tasksLoaded, jobId]);

  useEffect(() => {
    if (tab !== 'time' || timeLoaded || !jobId) return;
    void apiFetch(`/api/accounting/practice/time-entries?jobId=${jobId}`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { data?: { entries: PracticeTimeEntry[] } } | null) => {
        if (j) setEntries(j.data?.entries ?? []);
      })
      .finally(() => setTimeLoaded(true));
  }, [tab, timeLoaded, jobId]);

  async function save() {
    if (!job) return;
    setSaving(true); setBanner('');
    try {
      const r = await apiFetch(`/api/accounting/practice/jobs/${job.id}`, { method: 'PUT', body: JSON.stringify(form) });
      if (!r.ok) { const e = await r.json().catch(() => ({})) as { error?: string }; throw new Error(e.error ?? `HTTP ${r.status}`); }
      await loadJob();
    } catch (e) { setBanner(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  async function transition(s: PracticeJob['status']) {
    if (!job) return; setBanner('');
    try {
      const r = await apiFetch('/api/accounting/practice/jobs/transition', { method: 'POST', body: JSON.stringify({ id: job.id, newStatus: s }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})) as { error?: string }; throw new Error(e.error ?? `HTTP ${r.status}`); }
      await loadJob();
    } catch (e) { setBanner(e instanceof Error ? e.message : 'Transition failed'); }
  }

  async function del() {
    if (!job || !confirm('Delete this job?')) return; setBanner('');
    try {
      const r = await apiFetch(`/api/accounting/practice/jobs/${job.id}`, { method: 'DELETE' });
      if (!r.ok) { const e = await r.json().catch(() => ({})) as { error?: string }; throw new Error(e.error ?? `HTTP ${r.status}`); }
      void router.push('/accounting/practice/jobs');
    } catch (e) { setBanner(e instanceof Error ? e.message : 'Delete failed'); }
  }

  async function addTask() {
    if (!taskTitle.trim() || !job) return;
    setAdding(true);
    try {
      const r = await apiFetch('/api/accounting/practice/tasks', { method: 'POST', body: JSON.stringify({ jobId: job.id, title: taskTitle.trim() }) });
      if (r.ok) { const j = await r.json() as { data?: PracticeTask } | PracticeTask; setTasks(p => [...p, ('data' in j ? j.data : j) as PracticeTask]); setTaskTitle(''); }
    } catch { /* non-critical */ }
    finally { setAdding(false); }
  }

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-screen"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div></AppLayout>;
  if (error || !job) return (
    <AppLayout>
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertCircle className="h-12 w-12 text-[var(--ff-text-tertiary)]" />
        <p className="text-[var(--ff-text-secondary)] text-lg font-medium">{error || 'Job not found'}</p>
        <Link href="/accounting/practice/jobs" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"><ArrowLeft className="h-4 w-4" />Back to Jobs</Link>
      </div>
    </AppLayout>
  );

  const isOverdue = job.dueDate && job.status !== 'complete' && job.status !== 'cancelled' && new Date(job.dueDate) < new Date();
  const allowed = ALLOWED[job.status];
  const totalH = entries.reduce((s, e) => s + e.hours, 0);
  const billH = entries.filter(e => e.billable).reduce((s, e) => s + e.hours, 0);
  const totalV = entries.reduce((s, e) => s + (e.lineTotal ?? 0), 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <nav className="flex items-center gap-1.5 text-xs text-[var(--ff-text-tertiary)] mb-3">
              <Link href="/accounting/practice/jobs" className="hover:text-teal-400 transition-colors">Jobs</Link>
              <span>/</span><span className="text-[var(--ff-text-secondary)]">{job.title}</span>
            </nav>
            <div className="flex items-start gap-4">
              <Link href="/accounting/practice/jobs" className="mt-0.5 p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] transition-colors"><ArrowLeft className="h-4 w-4" /></Link>
              <div className="p-2 rounded-lg bg-teal-500/10"><Briefcase className="h-5 w-5 text-teal-400" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">{job.title}</h1>
                  <JobStatusBadge status={job.status} />
                  <span className="flex items-center gap-1 text-xs"><span className={`h-2 w-2 rounded-full ${PDOT[job.priority]}`} /><span className="text-[var(--ff-text-secondary)]">{PLBL[job.priority]}</span></span>
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-[var(--ff-text-secondary)]">
                  <Link href={`/accounting/practice/clients/${job.practiceClientId}`} className="hover:text-teal-400 transition-colors">{job.practiceClientName ?? trunc(job.practiceClientId)}</Link>
                  {job.dueDate && <span className={isOverdue ? 'text-amber-400 font-medium' : ''}>Due {job.dueDate}</span>}
                  {job.partnerId && <span>Partner: {trunc(job.partnerId)}</span>}
                  {job.preparerId && <span>Preparer: {trunc(job.preparerId)}</span>}
                  {job.budgetedHours != null && <span>{job.budgetedHours}h budgeted</span>}
                  {job.fixedFeeAmount != null && <span>R{job.fixedFeeAmount.toFixed(2)} fixed</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {allowed.length > 0 && (
                  <select onChange={e => { if (e.target.value) void transition(e.target.value as PracticeJob['status']); }} defaultValue="" className={`${inp} !w-auto`}>
                    <option value="">Transition →</option>
                    {allowed.map(s => <option key={s} value={s}>{SLBL[s]}</option>)}
                  </select>
                )}
                <button onClick={() => void del()} className="px-3 py-1.5 rounded-lg text-sm font-medium text-rose-400 hover:bg-rose-500/10 border border-rose-500/20 transition-colors">Delete</button>
              </div>
            </div>
            {banner && <div className="flex items-center gap-2 mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm"><AlertCircle className="h-4 w-4 shrink-0" />{banner}</div>}
            <div className="flex gap-1 mt-4">
              {(['details', 'tasks', 'time'] as Tab[]).map(t => <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${tab === t ? 'bg-teal-500/10 text-teal-400' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]'}`}>{t}</button>)}
            </div>
          </div>
        </div>

        <div className="px-6 py-6 max-w-4xl">
          {tab === 'details' && (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <label className="col-span-2"><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Title</span><input value={form.title ?? ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className={inp} /></label>
                <label className="col-span-2"><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Description</span><textarea rows={3} value={form.description ?? ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className={inp} /></label>
                <label><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Due Date</span><input type="date" value={form.dueDate ?? ''} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value || null }))} className={inp} /></label>
                <label><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Priority</span>
                  <select value={form.priority ?? 'normal'} onChange={e => setForm(f => ({ ...f, priority: e.target.value as PracticeJob['priority'] }))} className={inp}>
                    {(['low', 'normal', 'high', 'urgent'] as const).map(p => <option key={p} value={p}>{PLBL[p]}</option>)}
                  </select>
                </label>
                <label><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Financial Year</span><input value={form.financialYear ?? ''} onChange={e => setForm(f => ({ ...f, financialYear: e.target.value || null }))} className={inp} /></label>
                <label><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Billing Type</span>
                  <select value={form.billingType ?? ''} onChange={e => setForm(f => ({ ...f, billingType: (e.target.value || null) as PracticeJob['billingType'] }))} className={inp}>
                    <option value="">None</option><option value="hourly">Hourly</option><option value="fixed">Fixed</option><option value="retainer">Retainer</option>
                  </select>
                </label>
                <label><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Budgeted Hours</span><input type="number" min="0" step="0.5" value={form.budgetedHours ?? ''} onChange={e => setForm(f => ({ ...f, budgetedHours: e.target.value ? Number(e.target.value) : null }))} className={inp} /></label>
                <label><span className="block text-xs text-[var(--ff-text-secondary)] mb-1">Fixed Fee (R)</span><input type="number" min="0" step="0.01" value={form.fixedFeeAmount ?? ''} onChange={e => setForm(f => ({ ...f, fixedFeeAmount: e.target.value ? Number(e.target.value) : null }))} className={inp} /></label>
              </div>
              <div className="flex justify-end pt-2">
                <button onClick={() => void save()} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}Save Changes
                </button>
              </div>
            </div>
          )}

          {tab === 'tasks' && (
            <div className="space-y-4">
              {!tasksLoaded ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
                : tasks.length === 0 ? <div className="text-center py-12 text-[var(--ff-text-secondary)]">No tasks yet</div>
                : <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-bg-secondary)]">
                    <table className="w-full text-sm"><thead><tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]">{['Title', 'Assignee', 'Due', 'Priority', 'Status'].map(h => <TH key={h} h={h} />)}</tr></thead>
                    <tbody>{tasks.map(t => <tr key={t.id} className="border-b border-[var(--ff-border-primary)] last:border-0"><td className="py-2 px-3 text-[var(--ff-text-primary)] font-medium">{t.title}</td><td className="py-2 px-3 text-[var(--ff-text-secondary)]">{trunc(t.assignedTo)}</td><td className="py-2 px-3 text-[var(--ff-text-secondary)]">{fmt(t.dueDate)}</td><td className="py-2 px-3 text-[var(--ff-text-secondary)] capitalize">{t.priority}</td><td className="py-2 px-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TSTYLE[t.status]}`}>{t.status}</span></td></tr>)}</tbody>
                    </table>
                  </div>
              }
              <div className="flex gap-2">
                <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addTask(); }} placeholder="New task title…" className={`flex-1 ${inp}`} />
                <button onClick={() => void addTask()} disabled={adding || !taskTitle.trim()} className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">Add</button>
              </div>
            </div>
          )}

          {tab === 'time' && (
            <div className="space-y-4">
              {!timeLoaded ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div> : (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    {[['Total Hours', totalH.toFixed(1)], ['Billable Hours', billH.toFixed(1)], ['Total Value', `R${totalV.toFixed(2)}`]].map(([l, v]) => (
                      <div key={l} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-4">
                        <div className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)] mb-1"><Clock className="h-3.5 w-3.5" />{l}</div>
                        <div className="text-xl font-semibold text-[var(--ff-text-primary)]">{v}</div>
                      </div>
                    ))}
                  </div>
                  {entries.length === 0 ? <div className="text-center py-12 text-[var(--ff-text-secondary)]">No time entries for this job</div>
                    : <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-bg-secondary)]">
                        <table className="w-full text-sm"><thead><tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]">{['Date', 'User', 'Description', 'Hours', 'Rate', 'Total', 'Status'].map(h => <TH key={h} h={h} />)}</tr></thead>
                        <tbody>{entries.map(e => <tr key={e.id} className="border-b border-[var(--ff-border-primary)] last:border-0"><td className="py-2 px-3 text-[var(--ff-text-secondary)]"><Link href="/accounting/practice/time-entry" className="hover:text-teal-400 transition-colors">{e.entryDate}</Link></td><td className="py-2 px-3 text-[var(--ff-text-secondary)] font-mono text-xs">{trunc(e.userId)}</td><td className="py-2 px-3 text-[var(--ff-text-primary)] max-w-xs truncate">{e.taskDescription}</td><td className="py-2 px-3 text-[var(--ff-text-secondary)]">{e.hours}</td><td className="py-2 px-3 text-[var(--ff-text-secondary)]">{e.appliedRate != null ? `R${e.appliedRate}` : '—'}</td><td className="py-2 px-3 text-[var(--ff-text-secondary)]">{e.lineTotal != null ? `R${e.lineTotal.toFixed(2)}` : '—'}</td><td className="py-2 px-3"><span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-700 capitalize">{e.status}</span></td></tr>)}</tbody>
                        </table>
                      </div>
                  }
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
