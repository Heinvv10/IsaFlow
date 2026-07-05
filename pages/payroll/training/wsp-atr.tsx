/**
 * WSP/ATR summary — category rollup with planned vs actual cost.
 * Route: /payroll/training/wsp-atr
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { GraduationCap, Loader2, AlertCircle } from 'lucide-react';

interface CategoryRow {
  category: string;
  count: number;
  totalPlanned: number;
  totalActual: number;
  byStatus: Record<string, number>;
}
interface Report {
  year: number;
  categories: CategoryRow[];
  totals: { count: number; totalPlanned: number; totalActual: number };
}

const zar = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n);

const CATEGORY_LABEL: Record<string, string> = {
  aet: 'AET',
  learnership: 'Learnership',
  skills_programme: 'Skills programme',
  internship: 'Internship',
  bursary: 'Bursary',
  short_course: 'Short course',
  workshop: 'Workshop',
  other: 'Other',
};

export default function WspAtrPage() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/training-events/wsp-atr?year=${year}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error?.message ?? j.message ?? `HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      setReport((json.data ?? json) as Report);
    } finally {
      setLoading(false);
    }
  }, [year]);
  useEffect(() => {
    load().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load WSP/ATR report');
    });
  }, [load]);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <GraduationCap className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">WSP / ATR — {year}</h1>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm text-[var(--ff-text-secondary)]">Year</label>
          <input type="number" value={year} onChange={e => setYear(Number(e.target.value))}
            className="w-24 rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]" />
          <button onClick={load} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />{error}
          </div>
        )}

        {report && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
                <div className="text-xs text-[var(--ff-text-secondary)]">Total events</div>
                <div className="text-2xl font-semibold text-[var(--ff-text-primary)]">{report.totals.count}</div>
              </div>
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
                <div className="text-xs text-[var(--ff-text-secondary)]">Cost planned (WSP)</div>
                <div className="text-2xl font-semibold text-[var(--ff-text-primary)]">{zar(report.totals.totalPlanned)}</div>
              </div>
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
                <div className="text-xs text-[var(--ff-text-secondary)]">Cost actual (ATR)</div>
                <div className="text-2xl font-semibold text-[var(--ff-text-primary)]">{zar(report.totals.totalActual)}</div>
              </div>
            </div>

            <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
              <table className="min-w-full text-sm">
                <thead className="text-left text-[var(--ff-text-secondary)] bg-[var(--ff-surface-secondary)]">
                  <tr>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Events</th>
                    <th className="px-3 py-2 text-right">Planned</th>
                    <th className="px-3 py-2 text-right">In progress</th>
                    <th className="px-3 py-2 text-right">Completed</th>
                    <th className="px-3 py-2 text-right">Cancelled</th>
                    <th className="px-3 py-2 text-right">Cost planned</th>
                    <th className="px-3 py-2 text-right">Cost actual</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
                  {report.categories.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-[var(--ff-text-secondary)]">
                      No training events for {year}.
                    </td></tr>
                  ) : (
                    report.categories.map(c => (
                      <tr key={c.category}>
                        <td className="px-3 py-2">{CATEGORY_LABEL[c.category] ?? c.category}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.count}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--ff-text-secondary)]">{c.byStatus.planned ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--ff-text-secondary)]">{c.byStatus.in_progress ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--ff-text-secondary)]">{c.byStatus.completed ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--ff-text-secondary)]">{c.byStatus.cancelled ?? 0}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{zar(c.totalPlanned)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{zar(c.totalActual)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </AppLayout>
  );
}
