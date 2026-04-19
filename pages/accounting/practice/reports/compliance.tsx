/**
 * Compliance Report
 * Route: /accounting/practice/reports/compliance
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { ComplianceRow } from '@/modules/accounting/services/practice/practiceReportsService';
import type { CompanyUserSummary } from '@/modules/accounting/services/practice/practiceUsersService';
import { PeriodPicker } from '@/components/practice/PeriodPicker';
import type { PeriodRange } from '@/components/practice/PeriodPicker';

function firstOfMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().split('T')[0]!;
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';

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
  const [users, setUsers] = useState<CompanyUserSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodRange>({ dateFrom: firstOfMonth(), dateTo: todayIso() });

  useEffect(() => {
    apiFetch('/api/accounting/practice/users').then(async (res) => {
      if (!res.ok) return;
      const json = (await res.json()) as { data?: CompanyUserSummary[] } | CompanyUserSummary[];
      setUsers(Array.isArray(json) ? json : ((json as { data?: CompanyUserSummary[] }).data ?? []));
    }).catch(() => { /* non-critical */ });
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // compliance API uses periodStart/periodEnd — map from PeriodRange
    const qs = new URLSearchParams({ periodStart: period.dateFrom, periodEnd: period.dateTo });
    apiFetch(`/api/accounting/practice/reports/compliance?${qs.toString()}`)
      .then(async (res) => {
        const json = (await res.json()) as { data?: ComplianceRow[] } | ComplianceRow[];
        const data = (json && typeof json === 'object' && 'data' in json ? (json as { data: ComplianceRow[] }).data : json) as ComplianceRow[];
        setRows(data ?? []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [period.dateFrom, period.dateTo]);

  const userMap = new Map(users.map((u) => [u.id, u.displayName]));

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
          <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
            <PeriodPicker
              mode="range"
              value={period}
              onChange={(v) => setPeriod(v as PeriodRange)}
              labelRange={{ from: 'Period start', to: 'Period end' }}
            />
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
                          <td className={`${TD} font-mono`}>{userMap.get(r.userId) ?? r.userId.slice(0, 8)}</td>
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
