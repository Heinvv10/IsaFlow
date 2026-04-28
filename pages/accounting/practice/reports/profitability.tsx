/**
 * Client Profitability Report
 * Route: /accounting/practice/reports/profitability
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, TrendingUp, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { ProfitabilityRow } from '@/modules/accounting/services/practice/practiceReportsService';

const fmtZAR = (v: number) => formatCurrencyAmount(v, 'ZAR');
import { PeriodPicker } from '@/components/practice/PeriodPicker';
import type { PeriodRange } from '@/components/practice/PeriodPicker';
import { downloadCsv, reportFilename } from '@/lib/csvExport';
import type { CsvColumn } from '@/lib/csvExport';

function firstOfMonth() {
  const d = new Date();
  return localISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}
function todayIso() { return localISODate(); }

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';

function ErrBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />{msg}
    </div>
  );
}

export default function ProfitabilityPage() {
  const [rows, setRows] = useState<ProfitabilityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodRange>({ dateFrom: firstOfMonth(), dateTo: todayIso() });

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ dateFrom: period.dateFrom, dateTo: period.dateTo });
    apiFetch(`/api/accounting/practice/reports/profitability?${qs.toString()}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: ProfitabilityRow[] } | ProfitabilityRow[];
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: ProfitabilityRow[] }).data : json) as ProfitabilityRow[];
        setRows(data ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [period.dateFrom, period.dateTo]);

  function handleDownload() {
    const columns: CsvColumn<ProfitabilityRow>[] = [
      { header: 'Client', accessor: (r) => r.legalName },
      { header: 'Hours', accessor: (r) => r.hours },
      { header: 'Revenue (ZAR)', accessor: (r) => r.revenue },
      { header: 'Time cost (ZAR)', accessor: (r) => r.timeCost },
      { header: 'Margin (ZAR)', accessor: (r) => r.margin },
      { header: 'Margin %', accessor: (r) => r.marginPct },
    ];
    downloadCsv(reportFilename('profitability', period.dateFrom, period.dateTo), columns, rows);
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><TrendingUp className="h-5 w-5 text-teal-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Client Profitability</h1>
            <div className="ml-auto">
              <button
                onClick={handleDownload}
                disabled={rows.length === 0 && !loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border bg-white hover:bg-slate-50 text-sm text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="h-3.5 w-3.5" />Download CSV
              </button>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 max-w-7xl space-y-5">
          {/* filters */}
          <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <PeriodPicker mode="range" value={period} onChange={(v) => setPeriod(v as PeriodRange)} />
          </div>

          {/* Inclusion legend — addresses 2026-04-27 audit's "reports don't
              explain what's included" finding. */}
          <div className="text-xs text-[var(--ff-text-tertiary)] px-1">
            <span className="font-medium">Includes:</span> revenue from billed billable time entries (status = billed) + hours from all entries (draft, submitted, approved, billed). <span className="font-medium">Time cost / Margin</span> are reserved for staff cost-rate integration; currently shown as &mdash;.
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : (
              <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
                <table className="table-auto w-full">
                  <thead>
                    <tr className="bg-slate-50/5">
                      <th className={TH}>Client</th>
                      <th className={`${TH} text-right`}>Hours</th>
                      <th className={`${TH} text-right`}>Revenue</th>
                      <th className={`${TH} text-right`}>Time cost</th>
                      <th className={`${TH} text-right`}>Margin</th>
                      <th className={`${TH} text-right`}>Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? <tr><td colSpan={6} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">No data for this period.</td></tr>
                      : rows.map((r, i) => (
                        <tr key={r.practiceClientId} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                          <td className={`${TD} font-medium text-[var(--ff-text-primary)]`}>{r.legalName}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.hours.toFixed(2)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{fmtZAR(r.revenue)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.timeCost != null ? fmtZAR(r.timeCost) : '—'}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.margin != null ? fmtZAR(r.margin) : '—'}</td>
                          <td className={`${TD} text-right tabular-nums ${
                            r.marginPct == null ? 'text-slate-500'
                              : r.marginPct >= 30 ? 'text-emerald-400'
                              : r.marginPct >= 10 ? 'text-amber-400'
                              : r.marginPct < 0 ? 'text-rose-400 font-bold'
                              : 'text-rose-400'
                          }`}>{r.marginPct != null ? `${r.marginPct.toFixed(1)}%` : '—'}</td>
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
