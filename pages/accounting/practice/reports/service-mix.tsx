/**
 * Service Mix Report
 * Route: /accounting/practice/reports/service-mix
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, PieChart } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { ServiceMixRow } from '@/modules/accounting/services/practice/practiceReportsService';
import { PeriodPicker } from '@/components/practice/PeriodPicker';
import type { PeriodRange } from '@/components/practice/PeriodPicker';

function firstOfMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().split('T')[0]!;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';
const TF = 'py-2 px-3 text-sm font-semibold text-[var(--ff-text-primary)]';

function ErrBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />{msg}
    </div>
  );
}

function PctBar({ pct }: { pct: number }) {
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-slate-700 overflow-hidden">
        <div className="h-full rounded-full bg-slate-400" style={{ width: `${width}%` }} />
      </div>
      <span className="text-xs tabular-nums text-[var(--ff-text-tertiary)] w-10 text-right">{pct.toFixed(1)}%</span>
    </div>
  );
}

export default function ServiceMixPage() {
  const [rows, setRows] = useState<ServiceMixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodRange>({ dateFrom: firstOfMonth(), dateTo: todayIso() });

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ dateFrom: period.dateFrom, dateTo: period.dateTo });
    apiFetch(`/api/accounting/practice/reports/service-mix?${qs.toString()}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: ServiceMixRow[] } | ServiceMixRow[];
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: ServiceMixRow[] }).data : json) as ServiceMixRow[];
        setRows(data ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [period.dateFrom, period.dateTo]);

  const totals = rows.reduce(
    (s, r) => ({ hours: s.hours + r.hours, value: s.value + r.value }),
    { hours: 0, value: 0 },
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-500/10"><PieChart className="h-5 w-5 text-slate-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Service Mix</h1>
          </div>
        </div>

        <div className="px-6 py-5 max-w-7xl space-y-5">
          {/* filters */}
          <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <PeriodPicker mode="range" value={period} onChange={(v) => setPeriod(v as PeriodRange)} />
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : (
              <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
                <table className="table-auto w-full">
                  <thead>
                    <tr className="bg-slate-50/5">
                      <th className={TH}>Category</th>
                      <th className={`${TH} text-right`}>Hours</th>
                      <th className={`${TH} text-right`}>Value</th>
                      <th className={TH}>% share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? <tr><td colSpan={4} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">No data for this period.</td></tr>
                      : rows.map((r, i) => (
                        <tr key={r.jobCategoryId} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                          <td className={`${TD} font-medium text-[var(--ff-text-primary)]`}>{r.name}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.hours.toFixed(2)}</td>
                          <td className={`${TD} text-right tabular-nums`}>R{r.value.toFixed(2)}</td>
                          <td className={`${TD} min-w-[160px]`}><PctBar pct={r.pct} /></td>
                        </tr>
                      ))
                    }
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot>
                      <tr className="border-t-2 border-[var(--ff-border-primary)] bg-slate-50/10">
                        <td className={TF}>Totals</td>
                        <td className={`${TF} text-right tabular-nums`}>{totals.hours.toFixed(2)}</td>
                        <td className={`${TF} text-right tabular-nums`}>R{totals.value.toFixed(2)}</td>
                        <td className={TF}>100%</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )
          }
        </div>
      </div>
    </AppLayout>
  );
}
