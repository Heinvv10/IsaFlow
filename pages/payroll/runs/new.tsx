/**
 * New Payroll Run — Phase 2.
 * Route: /payroll/runs/new
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Plus, ArrowLeft, Loader2 } from 'lucide-react';

const MONTHS = [
  { v: 1, n: 'January' }, { v: 2, n: 'February' }, { v: 3, n: 'March' },
  { v: 4, n: 'April' }, { v: 5, n: 'May' }, { v: 6, n: 'June' },
  { v: 7, n: 'July' }, { v: 8, n: 'August' }, { v: 9, n: 'September' },
  { v: 10, n: 'October' }, { v: 11, n: 'November' }, { v: 12, n: 'December' },
];

export default function NewPayrollRunPage() {
  const router = useRouter();
  const today = new Date();
  const [month, setMonth] = useState<number>(today.getMonth() + 1);
  const [year, setYear] = useState<number>(today.getFullYear());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/runs', {
        method: 'POST',
        body: JSON.stringify({ month, year }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      const created = json.data ?? json;
      router.push(`/payroll/runs/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Plus className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Payroll Run</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Pick the period — calculation happens on the next page.</p>
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="p-6 max-w-md space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}
          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <div>
              <label className={label}>Month</label>
              <select className={field} value={month} onChange={e => setMonth(Number(e.target.value))}>
                {MONTHS.map(m => <option key={m.v} value={m.v}>{m.n}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Year</label>
              <input type="number" min="2020" max="2099" className={field}
                value={year} onChange={e => setYear(Number(e.target.value) || today.getFullYear())} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Run
            </button>
            <Link href="/payroll/runs" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
