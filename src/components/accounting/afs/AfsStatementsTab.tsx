// src/components/accounting/afs/AfsStatementsTab.tsx
// Inline Balance Sheet + Income Statement scoped to the AFS document period.

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BalanceSheetReport, IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';
import { AlertCircle } from 'lucide-react';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { toIncomeStatementRows } from '@/components/accounting/statement/incomeStatementRows';
import { toBalanceSheetRows } from '@/components/accounting/statement/balanceSheetRows';

interface Props {
  periodStart: string;
  periodEnd: string;
}

function SectionLoader() {
  return (
    <div className="animate-pulse space-y-2 py-8">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-full" />
      ))}
    </div>
  );
}

function SectionErr({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 p-4 rounded-lg bg-red-900/20 border border-red-800 text-sm text-red-400">
      <AlertCircle className="w-4 h-4 shrink-0" /> {message}
    </div>
  );
}

// ── Balance Sheet ─────────────────────────────────────────────────────────────

function BalanceSheetBlock({ report }: { report: BalanceSheetReport }) {
  const { assets, liabilitiesAndEquity } = toBalanceSheetRows(report, { comparative: false });
  const columns = { prior: false, variance: false, trend: false };
  return (
    <section className="mb-10">
      <h3 className="text-sm font-bold uppercase tracking-wide mb-3 text-[var(--ff-text-primary)]">
        Statement of Financial Position
      </h3>
      <div className="space-y-4">
        <StatementGrid rows={assets} columns={columns} title="Assets" cents />
        <StatementGrid rows={liabilitiesAndEquity} columns={columns} title="Liabilities and Equity" cents />
      </div>
    </section>
  );
}

// ── Income Statement ──────────────────────────────────────────────────────────

export function IncomeStatementBlock({ report, periodStart, periodEnd }: {
  report: IncomeStatementReport;
  periodStart: string;
  periodEnd: string;
}) {
  const rows = toIncomeStatementRows(report, { comparative: false });
  return (
    <section>
      <h3 className="text-sm font-bold uppercase tracking-wide mb-1 text-[var(--ff-text-primary)]">Statement of Comprehensive Income</h3>
      <p className="text-xs text-[var(--ff-text-tertiary)] mb-3">{periodStart} to {periodEnd}</p>
      <StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} cents />
    </section>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

type RemoteState<T> = { data: T | null; loading: boolean; error: string };

function useRemote<T>(url: string): RemoteState<T> {
  const [state, setState] = useState<RemoteState<T>>({ data: null, loading: true, error: '' });
  const fetch = useCallback(() => {
    setState({ data: null, loading: true, error: '' });
    apiFetch(url, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ data: T }>; })
      .then(json => setState({ data: json.data, loading: false, error: '' }))
      .catch((err: unknown) => {
        log.warn('AfsStatementsTab fetch failed', { url, error: err }, 'AfsStatementsTab');
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
  }, [url]);
  useEffect(() => { fetch(); }, [fetch]);
  return state;
}

export function AfsStatementsTab({ periodStart, periodEnd }: Props) {
  const bsUrl = `/api/accounting/reports-balance-sheet?as_at_date=${periodEnd}`;
  const isUrl = `/api/accounting/reports-income-statement?period_start=${periodStart}&period_end=${periodEnd}`;

  const bs = useRemote<BalanceSheetReport>(bsUrl);
  const is = useRemote<IncomeStatementReport>(isUrl);

  return (
    <div className="space-y-10">
      <div>
        {bs.loading ? <SectionLoader /> : bs.error ? <SectionErr message={bs.error} /> : bs.data ? (
          <BalanceSheetBlock report={bs.data} />
        ) : null}
      </div>
      <div>
        {is.loading ? <SectionLoader /> : is.error ? <SectionErr message={is.error} /> : is.data ? (
          <IncomeStatementBlock report={is.data} periodStart={periodStart} periodEnd={periodEnd} />
        ) : null}
      </div>
    </div>
  );
}
