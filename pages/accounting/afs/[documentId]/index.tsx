import React, { useState, useEffect } from 'react';
import type { NextPage, GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import type { ChangesInEquityReport } from '@/modules/accounting/services/afs/changesInEquityService';
import type { CashFlowDirectReport } from '@/modules/accounting/services/afs/cashFlowDirectService';
import type { CashFlowReconciliation } from '@/modules/accounting/services/afs/cashFlowReconciliationService';

interface PageProps {
  documentId: string;
  periodStart: string;
  periodEnd: string;
}

function fmt(amount: number): string {
  if (amount < 0)
    return `(${Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })})`;
  return amount.toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function SectionLoader({ label }: { label: string }) {
  return (
    <div className="animate-pulse bg-gray-50 border border-gray-200 rounded-lg p-6 mb-10">
      <div className="h-5 bg-gray-200 rounded w-1/3 mb-4" />
      <div className="space-y-2">
        {[1, 2, 3].map(i => <div key={i} className="h-4 bg-gray-100 rounded w-full" />)}
      </div>
      <p className="text-xs text-gray-400 mt-4">Loading {label}…</p>
    </div>
  );
}

function SectionError({ label, message }: { label: string; message: string }) {
  return (
    <div className="border border-red-200 bg-red-50 rounded-lg p-6 mb-10">
      <p className="text-sm font-semibold text-red-700">{label} — failed to load</p>
      <p className="text-xs text-red-500 mt-1">{message}</p>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-bold text-gray-900 uppercase tracking-wide mb-4 border-b border-gray-300 pb-2">
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
    <section className="mb-10">
      <SectionHeading>Statement of Changes in Equity</SectionHeading>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-gray-900 text-white">
              <th className="text-left p-3 font-semibold w-48">Movement</th>
              {report.columns.map(c => (
                <th key={c.subtype} className="text-right p-3 font-semibold">{c.label}</th>
              ))}
              <th className="text-right p-3 font-semibold">Total Equity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isTotal = row.key === 'closing' || row.key === 'opening';
              return (
                <tr
                  key={row.key}
                  className={isTotal
                    ? 'bg-gray-100 font-semibold border-t border-b border-gray-400'
                    : i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                >
                  <td className="p-3 text-gray-800">{row.label}</td>
                  {report.columns.map(c => (
                    <td key={c.subtype} className="text-right p-3 font-mono text-gray-900">
                      {fmt(c[row.key] as number)}
                    </td>
                  ))}
                  <td className="text-right p-3 font-mono font-semibold text-gray-900">
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
    <section className="mb-10">
      <SectionHeading>Statement of Cash Flows — Direct Method</SectionHeading>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-900 text-white">
            <th className="text-left p-3 font-semibold">Description</th>
            <th className="text-right p-3 font-semibold">R</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-gray-100">
            <td className="p-3 font-semibold text-gray-800" colSpan={2}>Operating Activities</td>
          </tr>
          {report.operatingItems.map((item, i) => (
            <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="p-3 pl-6 text-gray-700">{item.label}</td>
              <td className="text-right p-3 font-mono text-gray-900">{fmt(item.amount)}</td>
            </tr>
          ))}
          <tr className="bg-gray-200 font-semibold border-t border-gray-400">
            <td className="p-3 text-gray-900">Net cash from operating activities</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.operatingTotal)}</td>
          </tr>
          <tr className="bg-gray-100">
            <td className="p-3 font-semibold text-gray-800" colSpan={2}>Investing Activities</td>
          </tr>
          {report.investingItems.map((item, i) => (
            <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="p-3 pl-6 text-gray-700">{item.label}</td>
              <td className="text-right p-3 font-mono text-gray-900">{fmt(item.amount)}</td>
            </tr>
          ))}
          <tr className="bg-gray-200 font-semibold border-t border-gray-400">
            <td className="p-3 text-gray-900">Net cash from investing activities</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.investingTotal)}</td>
          </tr>
          <tr className="bg-gray-100">
            <td className="p-3 font-semibold text-gray-800" colSpan={2}>Financing Activities</td>
          </tr>
          {report.financingItems.map((item, i) => (
            <tr key={item.cashGroup} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
              <td className="p-3 pl-6 text-gray-700">{item.label}</td>
              <td className="text-right p-3 font-mono text-gray-900">{fmt(item.amount)}</td>
            </tr>
          ))}
          <tr className="bg-gray-200 font-semibold border-t border-gray-400">
            <td className="p-3 text-gray-900">Net cash from financing activities</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.financingTotal)}</td>
          </tr>
          <tr className="bg-white border-t border-gray-300">
            <td className="p-3 text-gray-700">Opening cash balance</td>
            <td className="text-right p-3 font-mono text-gray-900">{fmt(report.openingCash)}</td>
          </tr>
          <tr className="bg-gray-900 text-white font-bold">
            <td className="p-3">Closing cash balance</td>
            <td className="text-right p-3 font-mono">{fmt(report.closingCash)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function ReconciliationSection({ rec }: { rec: CashFlowReconciliation }) {
  const statusColour = rec.isReconciled ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300';
  return (
    <section className="mb-10">
      <SectionHeading>Cash Flow Reconciliation</SectionHeading>
      <div className={`border rounded-lg p-6 ${statusColour}`}>
        <table className="w-full text-sm">
          <tbody>
            <tr>
              <td className="py-1 text-gray-700">Direct method closing cash</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.directClosing)}</td>
            </tr>
            <tr>
              <td className="py-1 text-gray-700">Indirect method closing cash</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.indirectClosing)}</td>
            </tr>
            <tr>
              <td className="py-1 text-gray-700">Bank balance per GL</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.bankBalance)}</td>
            </tr>
            <tr className="border-t border-gray-300 font-semibold">
              <td className="py-2 text-gray-800">Variance</td>
              <td className="text-right font-mono text-gray-900">R {fmt(rec.variance)}</td>
            </tr>
          </tbody>
        </table>
        <p className={`mt-4 text-sm font-semibold ${rec.isReconciled ? 'text-green-700' : 'text-red-700'}`}>
          {rec.isReconciled
            ? '✓ Reconciled — cash figures agree within R0.01'
            : '✗ Variance detected — review required before export'}
        </p>
      </div>
    </section>
  );
}

interface RemoteState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

function useRemote<T>(url: string): RemoteState<T> {
  const [state, setState] = useState<RemoteState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    apiFetch(url, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ data: T }>;
      })
      .then(json => { if (!cancelled) setState({ data: json.data, error: null, loading: false }); })
      .catch((err: unknown) => {
        if (!cancelled) setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false });
      });
    return () => { cancelled = true; };
  }, [url]);

  return state;
}

const AfsDocumentPage: NextPage<PageProps> = ({ documentId, periodStart, periodEnd }) => {
  const params = `period_start=${periodStart}&period_end=${periodEnd}`;
  const base = `/api/accounting/afs/${documentId}/statements`;

  const equity  = useRemote<{ report: ChangesInEquityReport }>(`${base}/changes-in-equity?${params}`);
  const direct  = useRemote<{ report: CashFlowDirectReport }>(`${base}/cash-flow-direct?${params}`);
  const reconc  = useRemote<{ reconciliation: CashFlowReconciliation }>(`${base}/cash-flow-reconciliation?${params}`);

  return (
    <>
      <Head><title>AFS — {periodStart} to {periodEnd} | ISaFlow</title></Head>
      <div className="min-h-screen bg-gray-50">
        <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/accounting/afs" className="text-sm text-gray-500 hover:text-gray-700">← AFS Documents</Link>
            <span className="text-gray-300">/</span>
            <h1 className="text-sm font-semibold text-gray-900">Annual Financial Statements</h1>
          </div>
          <span className="text-xs text-gray-500">{periodStart} — {periodEnd}</span>
        </div>
        <div className="max-w-6xl mx-auto px-6 py-8">
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
      </div>
    </>
  );
};

export const getServerSideProps: GetServerSideProps<PageProps> = async ({ query }) => {
  const documentId = Array.isArray(query.documentId) ? query.documentId[0] : query.documentId;
  if (!documentId) return { notFound: true };
  const year = new Date().getFullYear();
  return {
    props: {
      documentId,
      periodStart: (query.period_start as string | undefined) ?? `${year}-01-01`,
      periodEnd:   (query.period_end   as string | undefined) ?? `${year}-12-31`,
    },
  };
};

export default AfsDocumentPage;
