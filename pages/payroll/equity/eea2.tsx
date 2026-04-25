/**
 * EEA2 Employment Equity matrix — level × race × gender with disability
 * and foreign-national pivots.
 * Route: /payroll/equity/eea2
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Scale, Loader2, AlertCircle } from 'lucide-react';

interface Cell { race: string; gender: string; count: number }
interface Level {
  levelId: string | null;
  levelCode: string | null;
  levelName: string | null;
  displayOrder: number;
  cells: Cell[];
  disabilityCount: number;
  foreignCount: number;
  total: number;
}
interface Report {
  asOf: string;
  levels: Level[];
  totals: { grandTotal: number; disabilityCount: number; foreignCount: number };
}

const RACES = ['african', 'coloured', 'indian', 'white', 'foreign'] as const;
const GENDERS = ['male', 'female'] as const;

export default function EEA2Page() {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/equity/eea2?asOf=${asOf}`);
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
  }, [asOf]);
  useEffect(() => { load(); }, [load]);

  function getCell(level: Level, race: string, gender: string): number {
    return level.cells.find(c => c.race === race && c.gender === gender)?.count ?? 0;
  }

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <div className="flex items-center gap-3">
          <Scale className="h-6 w-6 text-sky-500" />
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">EEA2 — Employment Equity</h1>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm text-[var(--ff-text-secondary)]">As of</label>
          <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)}
            className="rounded-md bg-[var(--ff-surface-secondary)] border border-[var(--ff-border-primary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]" />
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
                <div className="text-xs text-[var(--ff-text-secondary)]">Total active headcount</div>
                <div className="text-2xl font-semibold text-[var(--ff-text-primary)]">{report.totals.grandTotal}</div>
              </div>
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
                <div className="text-xs text-[var(--ff-text-secondary)]">With disability</div>
                <div className="text-2xl font-semibold text-[var(--ff-text-primary)]">{report.totals.disabilityCount}</div>
              </div>
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
                <div className="text-xs text-[var(--ff-text-secondary)]">Foreign nationals</div>
                <div className="text-2xl font-semibold text-[var(--ff-text-primary)]">{report.totals.foreignCount}</div>
              </div>
            </div>

            <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-[var(--ff-text-secondary)] bg-[var(--ff-surface-secondary)]">
                    <tr>
                      <th rowSpan={2} className="px-3 py-2">Occupational level</th>
                      {RACES.map(r => (
                        <th key={r} colSpan={2} className="px-2 py-2 text-center capitalize border-l border-[var(--ff-border-primary)]">{r}</th>
                      ))}
                      <th rowSpan={2} className="px-3 py-2 text-right border-l border-[var(--ff-border-primary)]">Disab</th>
                      <th rowSpan={2} className="px-3 py-2 text-right">Foreign</th>
                      <th rowSpan={2} className="px-3 py-2 text-right">Total</th>
                    </tr>
                    <tr>
                      {RACES.flatMap(r => GENDERS.map(g => (
                        <th key={`${r}-${g}`} className="px-2 py-1 text-right text-xs uppercase text-[var(--ff-text-tertiary)]">{g[0]}</th>
                      )))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-primary)] text-[var(--ff-text-primary)]">
                    {report.levels.length === 0 ? (
                      <tr><td colSpan={14} className="px-4 py-6 text-center text-[var(--ff-text-secondary)]">
                        No active employees as of this date.
                      </td></tr>
                    ) : (
                      report.levels.map(lvl => (
                        <tr key={lvl.levelCode ?? '__unspec__'}>
                          <td className="px-3 py-2">{lvl.levelName ?? '(Unspecified)'}</td>
                          {RACES.flatMap(r => GENDERS.map(g => (
                            <td key={`${r}-${g}`} className="px-2 py-2 text-right tabular-nums">
                              {getCell(lvl, r, g) || <span className="text-[var(--ff-text-tertiary)]">·</span>}
                            </td>
                          )))}
                          <td className="px-3 py-2 text-right border-l border-[var(--ff-border-primary)] tabular-nums">{lvl.disabilityCount || ''}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{lvl.foreignCount || ''}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">{lvl.total}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="text-xs text-[var(--ff-text-secondary)]">
              Cells show headcount for each (race, gender) pair. Unspecified employees (no equity fields set) appear
              in the &quot;Unspecified&quot; row at the bottom so the total always matches active headcount.
            </p>
          </>
        )}
      </div>
    </AppLayout>
  );
}
