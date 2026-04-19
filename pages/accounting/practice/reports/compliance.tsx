/**
 * Compliance Report
 * Route: /accounting/practice/reports/compliance
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { ComplianceRow } from '@/modules/accounting/services/practice/practiceReportsService';

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

function StatusBadge({ status }: { status: ComplianceRow['status'] }) {
  const cls =
    status === 'compliant' ? 'bg-green-500/15 text-green-400 border-green-500/30' :
    status === 'partial'   ? 'bg-amber-500/15 text-amber-400 border-amber-500/30' :
                             'bg-rose-500/15 text-rose-400 border-rose-500/30';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${cls} capitalize`}>
      {status}
    </span>
  );
}

function formatMissingDays(days: string[]) {
  if (days.length === 0) return '—';
  const shown = days.slice(0, 3).join(', ');
  return days.length > 3 ? `${shown} +${days.length - 3} more` : shown;
}

export default function CompliancePage() {
  const [rows, setRows] = useState<ComplianceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState({ periodStart: firstOfMonth(), periodEnd: todayIso() });

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ periodStart: params.periodStart, periodEnd: params.periodEnd });
    apiFetch(`/api/accounting/practice/reports/compliance?${qs.toString()}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: ComplianceRow[] } | ComplianceRow[];
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: ComplianceRow[] }).data : json) as ComplianceRow[];
        setRows(data ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [params.periodStart, params.periodEnd]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/10"><ShieldCheck className="h-5 w-5 text-green-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Compliance</h1>
          </div>
        </div>

        <div className="px-6 py-5 max-w-7xl space-y-5">
          {/* filters */}
          <div className="flex flex-wrap gap-4 items-end p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Period start</label>
              <input type="date" className={INPUT} value={params.periodStart}
                onChange={(e) => setParams((p) => ({ ...p, periodStart: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Period end</label>
              <input type="date" className={INPUT} value={params.periodEnd}
                onChange={(e) => setParams((p) => ({ ...p, periodEnd: e.target.value }))} />
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
                      <th className={`${TH} text-right`}>Expected days</th>
                      <th className={`${TH} text-right`}>Submitted days</th>
                      <th className={TH}>Missing days</th>
                      <th className={TH}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? <tr><td colSpan={5} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">No data for this period.</td></tr>
                      : rows.map((r, i) => (
                        <tr key={r.userId} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                          <td className={`${TD} font-mono`}>{r.userId.slice(0, 8)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.expectedDays}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.submittedDays}</td>
                          <td className={`${TD} font-mono text-xs`}>{formatMissingDays(r.missingDays)}</td>
                          <td className={TD}><StatusBadge status={r.status} /></td>
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
