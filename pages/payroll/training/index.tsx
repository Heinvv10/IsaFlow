/**
 * Training events — WSP/ATR capture list with inline create.
 * Route: /payroll/training
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { GraduationCap, Loader2, AlertCircle, Plus, X } from 'lucide-react';

interface Employee { id: string; employeeNumber: string; firstName: string; lastName: string }
interface Event {
  id: string;
  employeeId: string;
  category: string;
  description: string;
  provider: string | null;
  nqfLevel: number | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  costPlanned: number;
  costActual: number;
  status: string;
}

const CATEGORIES = [
  { v: 'aet', l: 'AET' },
  { v: 'learnership', l: 'Learnership' },
  { v: 'skills_programme', l: 'Skills programme' },
  { v: 'internship', l: 'Internship' },
  { v: 'bursary', l: 'Bursary' },
  { v: 'short_course', l: 'Short course' },
  { v: 'workshop', l: 'Workshop' },
  { v: 'other', l: 'Other' },
];

const STATUSES = [
  { v: 'planned', cls: 'bg-sky-500/10 text-sky-400' },
  { v: 'in_progress', cls: 'bg-amber-500/10 text-amber-400' },
  { v: 'completed', cls: 'bg-teal-500/10 text-teal-400' },
  { v: 'cancelled', cls: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]' },
];

const zar = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n);

export default function TrainingPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear());
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const todayIso = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    employeeId: '',
    category: 'short_course',
    description: '',
    provider: '',
    nqfLevel: '',
    plannedStart: todayIso,
    plannedEnd: todayIso,
    costPlanned: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eRes, emRes] = await Promise.all([
        apiFetch(`/api/payroll/training-events?year=${year}`),
        apiFetch('/api/payroll/employees'),
      ]);
      if (eRes.ok) {
        const json = await eRes.json();
        setEvents(((json.data ?? json) as Event[]) ?? []);
      }
      if (emRes.ok) {
        const json = await emRes.json();
        setEmployees(((json.data ?? json) as Employee[]) ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [year]);
  useEffect(() => { load(); }, [load]);

  async function handleCreate(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        employeeId: form.employeeId,
        category: form.category,
        description: form.description,
        costPlanned: form.costPlanned,
      };
      if (form.provider.trim()) body.provider = form.provider.trim();
      if (form.nqfLevel) body.nqfLevel = Number(form.nqfLevel);
      if (form.plannedStart) body.plannedStart = form.plannedStart;
      if (form.plannedEnd) body.plannedEnd = form.plannedEnd;

      const res = await apiFetch('/api/payroll/training-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.message ?? j.error ?? 'Create failed');
        return;
      }
      setShowForm(false);
      setForm({ ...form, description: '', provider: '', costPlanned: 0 });
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(id: string, status: string): Promise<void> {
    await apiFetch(`/api/payroll/training-events/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  const employeeName = (id: string): string => {
    const e = employees.find(x => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : id;
  };

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GraduationCap className="h-6 w-6 text-sky-500" />
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Training Events — WSP / ATR</h1>
          </div>
          <div className="flex items-center gap-2">
            <input type="number" value={year} onChange={e => setYear(Number(e.target.value))}
              className="w-24 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]" />
            <button onClick={() => setShowForm(!showForm)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> New event
            </button>
          </div>
        </div>

        {showForm && (
          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Capture training</h2>
              <button onClick={() => setShowForm(false)} className="text-[var(--ff-text-secondary)] hover:text-red-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <select value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
                <option value="">Employee...</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.employeeNumber} — {e.firstName} {e.lastName}</option>)}
              </select>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]">
                {CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
              </select>
              <input type="number" placeholder="NQF level (1-10)" value={form.nqfLevel}
                onChange={e => setForm({ ...form, nqfLevel: e.target.value })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              <input type="text" placeholder="Description" value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                className="col-span-2 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              <input type="text" placeholder="Provider" value={form.provider}
                onChange={e => setForm({ ...form, provider: e.target.value })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              <input type="date" value={form.plannedStart}
                onChange={e => setForm({ ...form, plannedStart: e.target.value })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              <input type="date" value={form.plannedEnd}
                onChange={e => setForm({ ...form, plannedEnd: e.target.value })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
              <input type="number" step="0.01" placeholder="Cost planned" value={form.costPlanned}
                onChange={e => setForm({ ...form, costPlanned: Number(e.target.value) })}
                className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            </div>
            <div className="flex justify-end">
              <button onClick={handleCreate} disabled={saving || !form.employeeId || !form.description.trim()}
                className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
            {error && (
              <div className="flex items-center gap-2 text-sm text-red-400">
                <AlertCircle className="h-4 w-4" />{error}
              </div>
            )}
          </section>
        )}

        <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-[var(--ff-text-secondary)] bg-[var(--ff-surface-secondary)]">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Provider</th>
                  <th className="px-3 py-2">NQF</th>
                  <th className="px-3 py-2">Planned</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
                {loading ? (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-[var(--ff-text-secondary)]">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading...
                  </td></tr>
                ) : events.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-[var(--ff-text-secondary)]">
                    No training events recorded for {year}.
                  </td></tr>
                ) : (
                  events.map(e => (
                    <tr key={e.id}>
                      <td className="px-3 py-2">{employeeName(e.employeeId)}</td>
                      <td className="px-3 py-2 text-xs uppercase text-[var(--ff-text-secondary)]">{e.category.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2">{e.description}</td>
                      <td className="px-3 py-2 text-[var(--ff-text-secondary)]">{e.provider ?? '·'}</td>
                      <td className="px-3 py-2">{e.nqfLevel ?? '·'}</td>
                      <td className="px-3 py-2 text-xs">{e.plannedStart ?? ''}{e.plannedEnd ? ` → ${e.plannedEnd}` : ''}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{zar(e.costPlanned)}</td>
                      <td className="px-3 py-2">
                        <select value={e.status} onChange={ev => setStatus(e.id, ev.target.value)}
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUSES.find(s => s.v === e.status)?.cls ?? ''}`}>
                          {STATUSES.map(s => <option key={s.v} value={s.v}>{s.v}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppLayout>
  );
}
