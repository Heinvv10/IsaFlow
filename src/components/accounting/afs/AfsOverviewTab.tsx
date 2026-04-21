// src/components/accounting/afs/AfsOverviewTab.tsx
// Overview tab content: Changes in Equity + both Cash Flow sections.

import React from 'react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useState, useEffect } from 'react';
import type { ChangesInEquityReport } from '@/modules/accounting/services/afs/changesInEquityService';
import type { CashFlowDirectReport } from '@/modules/accounting/services/afs/cashFlowDirectService';
import type { CashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

interface Props { documentId: string; periodStart: string; periodEnd: string; }

function fmt(amount: number): string {
  if (amount < 0)
    return `(${Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`;
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function SectionLoader({ label }: { label: string }) {
  return (
    <div className="animate-pulse bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg p-6 mb-8">
      <div className="h-5 bg-slate-200 dark:bg-slate-700 rounded w-1/3 mb-4" />
      {[1, 2, 3].map(i => <div key={i} className="h-4 bg-slate-100 dark:bg-slate-700/50 rounded w-full mb-2" />)}
      <p className="text-xs text-slate-500 mt-4">Loading {label}…</p>
    </div>
  );
}

function SectionError({ label, message }: { label: string; message: string }) {
  return (
    <div className="border border-red-800 bg-red-900/20 rounded-lg p-6 mb-8">
      <p className="text-sm font-semibold text-red-400">{label} — failed to load</p>
      <p className="text-xs text-red-500 mt-1">{message}</p>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide mb-4 border-b border-slate-300 dark:border-slate-700 pb-2">
      {children}
    </h2>
  );
}

function ChangesInEquitySection({ report }: { report: ChangesInEquityReport }) {
  type ColKey = keyof typeof report.columns[0];
  const rows: Array<{ label: string; key: ColKey }> = [
    { label: 'Opening balance', key: 'opening' },
    { label: 'Profit for year', key: 'profitForYear' },
    { label: 'Dividends paid',  key: 'dividends' },
    { label: 'Share issue',     key: 'shareIssue' },
    { label: 'Revaluation',     key: 'revaluation' },
    { label: 'Closing balance', key: 'closing' },
  ];
  const totalByRow: Record<string, number> = {
    opening:       report.totalOpening,
    profitForYear: report.totalProfitForYear,
    dividends:     report.totalDividends,
    shareIssue:    report.totalShareIssue,
    revaluation:   report.totalRevaluation,
    closing:       report.totalClosing,
  };
  return (
    <section className="mb-8">
      <SectionHeading>Statement of Changes in Equity</SectionHeading>
      <div className="overflow-x-auto rounded-lg border border-slate-300 dark:border-slate-700">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-200 dark:bg-slate-700">
              <th className="text-left px-4 py-3 font-semibold text-slate-800 dark:text-slate-200 w-48">Movement</th>
              {report.columns.map(c => (
                <th key={c.subtype} className="text-right px-4 py-3 font-semibold text-slate-800 dark:text-slate-200">{c.label}</th>
              ))}
              <th className="text-right px-4 py-3 font-semibold text-slate-800 dark:text-slate-200">Total Equity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTotal = row.key === 'closing' || row.key === 'opening';
              return (
                <tr
                  key={row.key}
                  className={isTotal
                    ? 'bg-slate-200 dark:bg-slate-700/60 font-semibold border-t border-b border-slate-300 dark:border-slate-600'
                    : i % 2 === 0 ? 'bg-slate-100 dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-800/50'}
                >
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{row.label}</td>
                  {report.columns.map(c => (
                    <td key={c.subtype} className="text-right px-4 py-3 font-mono text-slate-800 dark:text-slate-200">
                      {fmt(c[row.key] as number)}
                    </td>
                  ))}
                  <td className="text-right px-4 py-3 font-mono font-semibold text-slate-900 dark:text-white">
                    {fmt(totalByRow[row.key] ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DirectCashFlowSection({ report }: { report: CashFlowDirectReport }) {
  return (
    <section className="mb-8">
      <SectionHeading>Statement of Cash Flows — Direct Method</SectionHeading>
      <div className="rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-200 dark:bg-slate-700">
              <th className="text-left px-4 py-3 font-semibold text-slate-800 dark:text-slate-200">Description</th>
              <th className="text-right px-4 py-3 font-semibold text-slate-800 dark:text-slate-200">R</th>
            </tr>
          </thead>
          <tbody>
            {([
              { label: 'Operating', items: report.operatingItems, total: report.operatingTotal },
              { label: 'Investing', items: report.investingItems, total: report.investingTotal },
              { label: 'Financing', items: report.financingItems, total: report.financingTotal },
            ]).map((activity) => (
              <React.Fragment key={activity.label}>
                <tr className="bg-slate-100 dark:bg-slate-700/40">
                  <td className="px-4 py-3 font-semibold text-slate-700 dark:text-slate-300" colSpan={2}>{activity.label} Activities</td>
                </tr>
                {activity.items.map((item, i) => (
                  <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-slate-100 dark:bg-slate-800' : 'bg-slate-50 dark:bg-slate-800/50'}>
                    <td className="px-4 py-3 pl-8 text-slate-500 dark:text-slate-400">{item.label}</td>
                    <td className="text-right px-4 py-3 font-mono text-slate-800 dark:text-slate-200">{fmt(item.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-200 dark:bg-slate-700/60 font-semibold border-t border-slate-300 dark:border-slate-600">
                  <td className="px-4 py-3 text-slate-800 dark:text-slate-200">Net cash from {activity.label.toLowerCase()} activities</td>
                  <td className="text-right px-4 py-3 font-mono text-slate-900 dark:text-white">{fmt(activity.total)}</td>
                </tr>
              </React.Fragment>
            ))}
            <tr className="bg-slate-100 dark:bg-slate-800 border-t border-slate-600">
              <td className="px-4 py-3 text-slate-500 dark:text-slate-400">Opening cash balance</td>
              <td className="text-right px-4 py-3 font-mono text-slate-800 dark:text-slate-200">{fmt(report.openingCash)}</td>
            </tr>
            <tr className="bg-slate-200 dark:bg-slate-700 font-bold">
              <td className="px-4 py-3 text-slate-900 dark:text-white">Closing cash balance</td>
              <td className="text-right px-4 py-3 font-mono text-slate-900 dark:text-white">{fmt(report.closingCash)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReconciliationSection({ rec }: { rec: CashFlowReconciliation }) {
  const ok = rec.isReconciled;
  return (
    <section className="mb-8">
      <SectionHeading>Cash Flow Reconciliation</SectionHeading>
      <div className={`border rounded-lg p-6 ${ok ? 'bg-green-900/20 border-green-800' : 'bg-red-900/20 border-red-800'}`}>
        <table className="w-full text-sm">
          <tbody>
            {[
              { label: 'Direct method closing cash',   val: rec.directClosing },
              { label: 'Indirect method closing cash', val: rec.indirectClosing },
              { label: 'Bank balance per GL',          val: rec.bankBalance },
            ].map(row => (
              <tr key={row.label}>
                <td className="py-1 text-slate-500 dark:text-slate-400">{row.label}</td>
                <td className="text-right font-mono text-slate-800 dark:text-slate-200">R {fmt(row.val)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-600 font-semibold">
              <td className="py-2 text-slate-700 dark:text-slate-300">Variance</td>
              <td className="text-right font-mono text-slate-900 dark:text-white">R {fmt(rec.variance)}</td>
            </tr>
          </tbody>
        </table>
        <p className={`mt-4 text-sm font-semibold ${ok ? 'text-green-400' : 'text-red-400'}`}>
          {ok ? '✓ Reconciled — cash figures agree within R0.01' : '✗ Variance detected — review required before export'}
        </p>
      </div>
    </section>
  );
}

interface RemoteState<T> { data: T | null; error: string | null; loading: boolean; }

function useRemote<T>(url: string): RemoteState<T> {
  const [state, setState] = useState<RemoteState<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    apiFetch(url, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ data: T }>; })
      .then(json => { if (!cancelled) setState({ data: json.data, error: null, loading: false }); })
      .catch((err: unknown) => {
        if (!cancelled) {
          log.warn('Remote fetch failed', { url, error: err }, 'afs-overview');
          setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false });
        }
      });
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

export function AfsOverviewTab({ documentId, periodStart, periodEnd }: Props) {
  const params = `period_start=${periodStart}&period_end=${periodEnd}`;
  const base = `/api/accounting/afs/${documentId}/statements`;

  const equity = useRemote<{ report: ChangesInEquityReport }>(`${base}/changes-in-equity?${params}`);
  const direct = useRemote<{ report: CashFlowDirectReport }>(`${base}/cash-flow-direct?${params}`);
  const reconc = useRemote<{ reconciliation: CashFlowReconciliation }>(`${base}/cash-flow-reconciliation?${params}`);

  return (
    <div>
      {/* Quick links to the standalone statement pages, pre-scoped to this AFS period. */}
      <div className="flex gap-3 mb-8">
        <Link
          href={`/accounting/reports/balance-sheet?as_at_date=${periodEnd}`}
          className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-white transition-colors"
        >
          Balance Sheet →
        </Link>
        <Link
          href={`/accounting/reports/income-statement?${params}`}
          className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-white transition-colors"
        >
          Income Statement →
        </Link>
      </div>

      {equity.error
        ? <SectionError label="Statement of Changes in Equity" message={equity.error} />
        : equity.loading || !equity.data
          ? <SectionLoader label="Statement of Changes in Equity" />
          : <ChangesInEquitySection report={equity.data.report} />}

      {direct.error
        ? <SectionError label="Statement of Cash Flows (Direct)" message={direct.error} />
        : direct.loading || !direct.data
          ? <SectionLoader label="Direct Method Cash Flow" />
          : <DirectCashFlowSection report={direct.data.report} />}

      {reconc.error
        ? <SectionError label="Cash Flow Reconciliation" message={reconc.error} />
        : reconc.loading || !reconc.data
          ? <SectionLoader label="Cash Flow Reconciliation" />
          : <ReconciliationSection rec={reconc.data.reconciliation} />}
    </div>
  );
}
