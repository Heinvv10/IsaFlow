/**
 * Staff Utilisation Report
 * Route: /accounting/practice/reports/utilisation
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, BarChart2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { UtilisationRow } from '@/modules/accounting/services/practice/practiceReportsService';

function firstOfMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }
function todayIso() { return new Date().toISOString().slice(0, 10); }

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';
const INPUT = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/40';

function ErrBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />{msg}
    </div>
  );
}

function utilColour(pct: number) {
  if (pct >= 70) return 'text-green-400';
  if (pct >= 40) return 'text-amber-400';
  return 'text-rose-400';
}

export default function UtilisationPage() {
  const [rows, setRows] = useState<UtilisationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState({ dateFrom: firstOfMonth(), dateTo: todayIso(), userId: '' });

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ dateFrom: params.dateFrom, dateTo: params.dateTo });
    if (params.userId.trim()) qs.set('userId', params.userId.trim());
    apiFetch(`/api/accounting/practice/reports/utilisation?${qs.toString()}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: UtilisationRow[] } | UtilisationRow[];
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: UtilisationRow[] }).data : json) as UtilisationRow[];
        setRows(data ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [params.dateFrom, params.dateTo, params.userId]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><BarChart2 className="h-5 w-5 text-teal-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Staff Utilisation</h1>
          </div>
        </div>

        <div className="px-6 py-5 max-w-7xl space-y-5">
          {/* filters */}
          <div className="flex flex-wrap gap-4 items-end p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Date from</label>
              <input type="date" className={INPUT} value={params.dateFrom}
                onChange={(e) => setParams((p) => ({ ...p, dateFrom: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Date to</label>
              <input type="date" className={INPUT} value={params.dateTo}
                onChange={(e) => setParams((p) => ({ ...p, dateTo: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">User ID (optional)</label>
              <input type="text" className={INPUT} placeholder="Filter by user id…" value={params.userId}
                onChange={(e) => setParams((p) => ({ ...p, userId: e.target.value }))} />
            </div>
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : (
              <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
                <table className="table-auto w-full">
                  <thead>
                    <tr className="bg-slate-50/5">
                      <th className={TH}>User ID</th>
                      <th className={`${TH} text-right`}>Total hrs</th>
                      <th className={`${TH} text-right`}>Billable hrs</th>
                      <th className={`${TH} text-right`}>Non-billable hrs</th>
                      <th className={`${TH} text-right`}>Billable value</th>
                      <th className={`${TH} text-right`}>Utilisation %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? <tr><td colSpan={6} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">No data for this period.</td></tr>
                      : rows.map((r, i) => (
                        <tr key={r.userId} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                          <td className={TD}>{r.userId.slice(0, 8)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.totalHours.toFixed(2)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.billableHours.toFixed(2)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.nonBillableHours.toFixed(2)}</td>
                          <td className={`${TD} text-right tabular-nums`}>R{r.billableValue.toFixed(2)}</td>
                          <td className={`${TD} text-right tabular-nums font-semibold ${utilColour(r.utilisationPct)}`}>{r.utilisationPct.toFixed(1)}%</td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            )
          }
        </div>
      </div>
    </AppLayout>
  );
}
