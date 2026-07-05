/**
 * Pay Scales — list, inline create, toggle active.
 * Route: /payroll/pay-scales
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Scale, Loader2, AlertCircle, Plus } from 'lucide-react';

interface PayScale {
  id: string;
  code: string;
  name: string;
  gradeLevel: number;
  minSalary: number;
  midSalary: number;
  maxSalary: number;
  currency: string;
  isActive: boolean;
  notes: string | null;
}

const zar = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n);

export default function PayScalesPage() {
  const [scales, setScales] = useState<PayScale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', gradeLevel: 1, minSalary: 0, midSalary: 0, maxSalary: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/pay-scales');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setScales(((json.data ?? json) as PayScale[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function handleCreate(): Promise<void> {
    setCreating(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/pay-scales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? 'Create failed');
        return;
      }
      setForm({ code: '', name: '', gradeLevel: 1, minSalary: 0, midSalary: 0, maxSalary: 0 });
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(s: PayScale): Promise<void> {
    await apiFetch(`/api/payroll/pay-scales/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !s.isActive }),
    });
    await load();
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Scale className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Pay Scales</h1>
        </div>

        <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-3">New pay scale</h2>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
            <input placeholder="Code (G5)" value={form.code}
              onChange={e => setForm({ ...form, code: e.target.value })}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            <input placeholder="Name" value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="col-span-2 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            <input type="number" placeholder="Grade" value={form.gradeLevel}
              onChange={e => setForm({ ...form, gradeLevel: Number(e.target.value) })}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            <input type="number" placeholder="Min" value={form.minSalary}
              onChange={e => setForm({ ...form, minSalary: Number(e.target.value) })}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
            <input type="number" placeholder="Mid" value={form.midSalary}
              onChange={e => setForm({ ...form, midSalary: Number(e.target.value) })}
              className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-[var(--ff-text-primary)]" />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <input type="number" placeholder="Max" value={form.maxSalary}
              onChange={e => setForm({ ...form, maxSalary: Number(e.target.value) })}
              className="w-32 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]" />
            <button onClick={handleCreate} disabled={creating || !form.code.trim() || !form.name.trim()}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
              <Plus className="h-4 w-4" /> Create
            </button>
          </div>
        </section>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />{error}
          </div>
        )}

        <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="text-left text-[var(--ff-text-secondary)] bg-[var(--ff-surface-secondary)]">
              <tr>
                <th className="px-4 py-2">Code</th>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2 text-right">Grade</th>
                <th className="px-4 py-2 text-right">Min</th>
                <th className="px-4 py-2 text-right">Mid</th>
                <th className="px-4 py-2 text-right">Max</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-[var(--ff-text-secondary)]">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading...
                </td></tr>
              ) : scales.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-[var(--ff-text-secondary)]">No pay scales yet.</td></tr>
              ) : (
                scales.map(s => (
                  <tr key={s.id}>
                    <td className="px-4 py-2 font-mono">{s.code}</td>
                    <td className="px-4 py-2">{s.name}</td>
                    <td className="px-4 py-2 text-right">{s.gradeLevel}</td>
                    <td className="px-4 py-2 text-right">{zar(s.minSalary)}</td>
                    <td className="px-4 py-2 text-right">{zar(s.midSalary)}</td>
                    <td className="px-4 py-2 text-right">{zar(s.maxSalary)}</td>
                    <td className="px-4 py-2">
                      <button onClick={() => toggleActive(s)}
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          s.isActive ? 'bg-teal-500/10 text-teal-400' : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
                        }`}>
                        {s.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </div>
    </AppLayout>
  );
}
