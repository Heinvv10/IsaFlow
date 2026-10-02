/**
 * Engagement Budgets Report
 * Route: /accounting/practice/reports/engagement-budgets
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, AlertCircle, Wallet, Download } from 'lucide-react';
import { fetchActiveClients, fetchJobBudgets, type JobBudgetRow, type PracticeClient } from '@/components/practice/practiceApi';
import { fmtRand, BUDGET_STATE_TEXT, BUDGET_STATE_LABEL } from '@/components/practice/EngagementBudgetSummary';
import { downloadCsv } from '@/lib/csvExport';
import { apiErrorMessage } from '@/lib/apiFetch';
import type { CsvColumn } from '@/lib/csvExport';
import { localISODate } from '@/lib/dateUtils';

const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';
const SC = 'py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';

function ErrBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-700 dark:text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" />{msg}
    </div>
  );
}

const hoursCell = (r: JobBudgetRow) =>
  r.budgetedHours != null ? `${r.hoursUsed.toFixed(2)} / ${r.budgetedHours.toFixed(2)}` : r.hoursUsed.toFixed(2);

export default function EngagementBudgetsPage() {
  const [rows, setRows] = useState<JobBudgetRow[]>([]);
  const [clients, setClients] = useState<PracticeClient[]>([]);
  const [clientId, setClientId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActiveClients()
      .then(setClients)
      .catch((e: unknown) => setError(apiErrorMessage(e, 'Could not load the clients - try again')));
  }, []);

  useEffect(() => {
    // A slower earlier response must not overwrite the rows of the client chosen since.
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJobBudgets(clientId || undefined)
      .then((r) => { if (!cancelled) setRows(r); })
      // A failed load must not leave the previous client's rows on screen under the new filter.
      .catch((e: unknown) => { if (!cancelled) { setRows([]); setError(apiErrorMessage(e, 'Could not load the engagement budgets - try again')); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clientId]);

  function handleDownload() {
    const columns: CsvColumn<JobBudgetRow>[] = [
      { header: 'Job', accessor: (r) => r.title },
      { header: 'Client', accessor: (r) => r.practiceClientName ?? '' },
      { header: 'Job status', accessor: (r) => r.jobStatus },
      { header: 'Engagement Budget (ZAR)', accessor: (r) => r.budgetAmount ?? '' },
      { header: 'Used (ZAR)', accessor: (r) => r.consumedAmount },
      { header: 'Engagement Budget Balance (ZAR)', accessor: (r) => r.balance ?? '' },
      { header: 'Hours used', accessor: (r) => r.hoursUsed },
      { header: 'Budgeted hours', accessor: (r) => r.budgetedHours ?? '' },
      { header: '% used', accessor: (r) => r.percentUsed ?? '' },
      { header: 'State', accessor: (r) => BUDGET_STATE_LABEL[r.state] },
    ];
    downloadCsv(`engagement-budgets-${localISODate()}.csv`, columns, rows);
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><Wallet className="h-5 w-5 text-teal-400" /></div>
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Engagement Budgets</h1>
            <div className="ml-auto">
              <button
                onClick={handleDownload}
                disabled={loading || rows.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border bg-white hover:bg-slate-50 text-sm text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="h-3.5 w-3.5" />Download CSV
              </button>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 max-w-7xl space-y-5">
          <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] flex items-center gap-3">
            <label className="text-sm font-medium text-[var(--ff-text-primary)]" htmlFor="eb-client">Client</label>
            <select id="eb-client" value={clientId} onChange={(e) => setClientId(e.target.value)} className={SC}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.tradingName ?? c.legalName}</option>)}
            </select>
          </div>

          {/* --ff-text-tertiary read 2.54:1 on the light page; slate-600 / slate-300 clear 4.5:1 in both themes. */}
          <div className={`text-xs px-1 ${BUDGET_STATE_TEXT.none}`} data-testid="eb-report-note">
            <span className="font-medium">Includes:</span> all time captured against each job — draft, submitted, approved, billed, non-billable and written-off — valued at hours &times; staff rate. Leave is excluded; an entry with no rate counts its hours only. Amber from 80% used, red once over budget. Over-budget jobs are listed first.
          </div>

          {error && <ErrBanner msg={error} />}

          {loading
            ? <div className="flex items-center gap-2 py-12 justify-center text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-5 w-5 animate-spin" />Loading…</div>
            : (
              <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
                <table className="table-auto w-full">
                  <thead>
                    <tr className="bg-slate-50/5">
                      <th className={TH}>Job</th>
                      <th className={TH}>Client</th>
                      <th className={`${TH} text-right`}>Engagement Budget</th>
                      <th className={`${TH} text-right`}>Used</th>
                      <th className={`${TH} text-right`}>Balance</th>
                      <th className={`${TH} text-right`}>Hours (used / budget)</th>
                      <th className={`${TH} text-right`}>% Used</th>
                      <th className={TH}>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0
                      ? <tr><td colSpan={8} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">No jobs.</td></tr>
                      : rows.map((r, i) => (
                        <tr key={r.jobId} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                          <td className={`${TD} font-medium text-[var(--ff-text-primary)]`}>
                            <Link href={`/accounting/practice/jobs/${r.jobId}`} className="hover:text-teal-400">{r.title}</Link>
                          </td>
                          <td className={TD}>{r.practiceClientName ?? '—'}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.budgetAmount != null ? fmtRand(r.budgetAmount) : 'No budget'}</td>
                          <td className={`${TD} text-right tabular-nums`}>{fmtRand(r.consumedAmount)}</td>
                          <td className={`${TD} text-right tabular-nums font-medium ${BUDGET_STATE_TEXT[r.state]}`}>
                            {r.balance != null ? fmtRand(r.balance) : '—'}
                          </td>
                          <td className={`${TD} text-right tabular-nums`}>{hoursCell(r)}</td>
                          <td className={`${TD} text-right tabular-nums`}>{r.percentUsed != null ? `${r.percentUsed.toFixed(1)}%` : '—'}</td>
                          <td className={`${TD} ${BUDGET_STATE_TEXT[r.state]}`}>{BUDGET_STATE_LABEL[r.state]}</td>
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
