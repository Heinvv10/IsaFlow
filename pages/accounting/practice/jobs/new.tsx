/** New Practice Job Page — /accounting/practice/jobs/new */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Briefcase, Loader2, ArrowLeft, Save, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import type { PracticeJob } from '@/modules/accounting/services/practice/practiceJobService';
import type { CompanyUserSummary } from '@/modules/accounting/services/practice/practiceUsersService';

interface Opt { id: string; name?: string; legalName?: string }
interface FormState {
  practiceClientId: string; title: string; description: string; jobCategoryId: string;
  partnerId: string; preparerId: string; dueDate: string; priority: PracticeJob['priority'];
  financialYear: string; billingType: '' | 'hourly' | 'fixed' | 'retainer';
  budgetedHours: string; fixedFeeAmount: string;
}
const INITIAL: FormState = {
  practiceClientId: '', title: '', description: '', jobCategoryId: '',
  partnerId: '', preparerId: '', dueDate: '', priority: 'normal',
  financialYear: '', billingType: '', budgetedHours: '', fixedFeeAmount: '',
};
const IC = 'w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
const SC = 'w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
const LC = 'block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5';

async function fetchOpts(url: string): Promise<Opt[]> {
  const r = await apiFetch(url); if (!r.ok) return [];
  const j = await r.json() as unknown;
  const payload = (j && typeof j === 'object' && 'data' in j ? (j as { data: unknown }).data : j) as unknown;
  if (Array.isArray(payload)) return payload as Opt[];
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const k of ['clients', 'jobs', 'tasks', 'categories', 'workItems', 'items']) {
      if (Array.isArray(p[k])) return p[k] as Opt[];
    }
  }
  return [];
}

async function fetchUsers(): Promise<CompanyUserSummary[]> {
  const r = await apiFetch('/api/accounting/practice/users'); if (!r.ok) return [];
  const j = await r.json() as { data?: CompanyUserSummary[] } | CompanyUserSummary[];
  return (Array.isArray(j) ? j : (j as { data?: CompanyUserSummary[] }).data) ?? [];
}

export default function NewPracticeJobPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [clients, setClients] = useState<Opt[]>([]); const [cats, setCats] = useState<Opt[]>([]);
  const [users, setUsers] = useState<CompanyUserSummary[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false); const [error, setError] = useState('');
  const [fe, setFe] = useState<Partial<Record<keyof FormState, string>>>({});

  useEffect(() => {
    void Promise.all([
      fetchOpts('/api/accounting/practice/clients?status=active').then(setClients),
      fetchOpts('/api/accounting/practice/job-categories?isActive=true').then(setCats),
      fetchUsers().then(setUsers),
    ]);
  }, []);

  // Pre-select the client if the route includes ?clientId=… — used by the
  // welcome banner on the practice client detail page to chain "create a job
  // for this client" without making the user re-select.
  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query.clientId;
    const id = Array.isArray(q) ? q[0] : q;
    if (id && typeof id === 'string') {
      setForm((p) => (p.practiceClientId ? p : { ...p, practiceClientId: id }));
    }
  }, [router.isReady, router.query.clientId]);

  function set(f: keyof FormState, v: string) {
    setForm((p) => ({ ...p, [f]: v }));
    if (fe[f]) setFe((p) => ({ ...p, [f]: undefined }));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.practiceClientId) e.practiceClientId = 'Client is required';
    if (!form.title.trim()) e.title = 'Title is required';
    setFe(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true); setError('');
    try {
      const body = {
        practiceClientId: form.practiceClientId, title: form.title.trim(),
        description: form.description.trim() || undefined, jobCategoryId: form.jobCategoryId || undefined,
        partnerId: form.partnerId.trim() || undefined, preparerId: form.preparerId.trim() || undefined,
        dueDate: form.dueDate || undefined, priority: form.priority,
        financialYear: form.financialYear.trim() || undefined, billingType: form.billingType || undefined,
        budgetedHours: form.budgetedHours ? Number(form.budgetedHours) : undefined,
        fixedFeeAmount: form.fixedFeeAmount ? Number(form.fixedFeeAmount) : undefined,
      };
      const res = await apiFetch('/api/accounting/practice/jobs', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) { const j = await res.json().catch(() => ({})) as { error?: string }; throw new Error(j.error ?? `HTTP ${res.status}`); }
      const j = await res.json() as { data?: PracticeJob } | PracticeJob;
      await router.push(`/accounting/practice/jobs/${((j as { data?: PracticeJob }).data ?? (j as PracticeJob)).id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job');
    } finally { setIsSubmitting(false); }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-4">
            <Link href="/accounting/practice/jobs" className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><Briefcase className="h-5 w-5 text-teal-400" /></div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">New Job</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Create a practice job</p>
              </div>
            </div>
          </div>
        </div>
        <div className="px-6 py-8 max-w-2xl">
          {error && (
            <div className="flex items-center gap-2 p-3 mb-6 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span>
            </div>
          )}
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
            <div>
              <label className={LC}>Client <span className="text-red-400">*</span></label>
              <select value={form.practiceClientId} onChange={(e) => set('practiceClientId', e.target.value)}
                className={`${SC}${fe.practiceClientId ? ' border-red-500' : ''}`}>
                <option value="">Select a client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.legalName ?? c.name}</option>)}
              </select>
              {fe.practiceClientId && <p className="mt-1 text-xs text-red-400">{fe.practiceClientId}</p>}
            </div>
            <div>
              <label className={LC}>Title <span className="text-red-400">*</span></label>
              <input type="text" value={form.title} onChange={(e) => set('title', e.target.value)}
                placeholder="e.g. FY2025 Annual Financial Statements"
                className={`${IC}${fe.title ? ' border-red-500' : ''}`} />
              {fe.title && <p className="mt-1 text-xs text-red-400">{fe.title}</p>}
            </div>
            <div>
              <label className={LC}>Description</label>
              <textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)}
                placeholder="Optional job description" className={`${IC} resize-none`} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={LC}>Category</label>
                <select value={form.jobCategoryId} onChange={(e) => set('jobCategoryId', e.target.value)} className={SC}>
                  <option value="">— None —</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className={LC}>Priority</label>
                <select value={form.priority} onChange={(e) => set('priority', e.target.value as PracticeJob['priority'])} className={SC}>
                  <option value="low">Low</option><option value="normal">Normal</option>
                  <option value="high">High</option><option value="urgent">Urgent</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={LC}>Partner</label>
                {users.length > 0 ? (
                  <select value={form.partnerId} onChange={(e) => set('partnerId', e.target.value)} className={SC}>
                    <option value="">— select —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                  </select>
                ) : (
                  <input type="text" value={form.partnerId} onChange={(e) => set('partnerId', e.target.value)} placeholder="UUID" className={IC} />
                )}
              </div>
              <div>
                <label className={LC}>Preparer</label>
                {users.length > 0 ? (
                  <select value={form.preparerId} onChange={(e) => set('preparerId', e.target.value)} className={SC}>
                    <option value="">— select —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                  </select>
                ) : (
                  <input type="text" value={form.preparerId} onChange={(e) => set('preparerId', e.target.value)} placeholder="UUID" className={IC} />
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={LC}>Due Date</label>
                <input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} className={IC} />
              </div>
              <div>
                <label className={LC}>Financial Year</label>
                <input type="text" value={form.financialYear} onChange={(e) => set('financialYear', e.target.value)} placeholder="e.g. 2025" className={IC} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={LC}>Billing Type</label>
                <select value={form.billingType} onChange={(e) => set('billingType', e.target.value)} className={SC}>
                  <option value="">— None —</option>
                  <option value="hourly">Hourly</option><option value="fixed">Fixed</option><option value="retainer">Retainer</option>
                </select>
              </div>
              <div>
                <label className={LC}>Budgeted Hrs</label>
                <input type="number" min="0" step="0.5" value={form.budgetedHours} onChange={(e) => set('budgetedHours', e.target.value)} placeholder="0" className={IC} />
              </div>
              <div>
                <label className={LC}>Fixed Fee (R)</label>
                <input type="number" min="0" step="0.01" value={form.fixedFeeAmount} onChange={(e) => set('fixedFeeAmount', e.target.value)} placeholder="0.00" className={IC} />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <button type="submit" disabled={isSubmitting}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isSubmitting ? 'Saving…' : 'Save Job'}
              </button>
              <Link href="/accounting/practice/jobs" className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors">
                Cancel
              </Link>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
