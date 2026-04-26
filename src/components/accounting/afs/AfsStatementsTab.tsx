// src/components/accounting/afs/AfsStatementsTab.tsx
// Inline Balance Sheet + Income Statement scoped to the AFS document period.

import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BalanceSheetReport, BalanceSheetLineItem, IncomeStatementReport, IncomeStatementLineItem } from '@/modules/accounting/types/gl.report.types';
import { formatCurrency } from '@/utils/formatters';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

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

function AccountRow({ code, name, balance }: { code: string; name: string; balance: number; }) {
  return (
    <div className="px-4 py-2 flex justify-between text-sm">
      <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
        <span className="font-mono text-xs text-slate-400">{code}</span>
        {name}
      </span>
      <span className="font-mono text-slate-800 dark:text-slate-200">{formatCurrency(balance)}</span>
    </div>
  );
}

function BSSection({ label, color, items, total }: {
  label: string;
  color: 'blue' | 'amber' | 'purple';
  items: BalanceSheetLineItem[];
  total: number;
}) {
  const colorMap = {
    blue:   { header: 'bg-blue-500/10 text-blue-500',   total: 'text-blue-400' },
    amber:  { header: 'bg-amber-500/10 text-amber-500', total: 'text-amber-400' },
    purple: { header: 'bg-purple-500/10 text-purple-500', total: 'text-purple-400' },
  };
  const c = colorMap[color];
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden mb-4">
      <div className={`px-4 py-2 font-semibold text-sm ${c.header}`}>{label}</div>
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map(a => <AccountRow key={a.accountCode} code={a.accountCode} name={a.accountName} balance={a.balance} />)}
        {items.length === 0 && <div className="px-4 py-2 text-xs text-slate-400">No balances</div>}
      </div>
      <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-700 flex justify-between bg-slate-50 dark:bg-slate-800">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Total {label}</span>
        <span className={`font-mono font-bold ${c.total}`}>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

function BalanceSheetBlock({ report }: { report: BalanceSheetReport }) {
  const balanced = Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)) < 0.02;
  return (
    <section className="mb-10">
      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide mb-3 border-b border-slate-300 dark:border-slate-700 pb-1">
        Statement of Financial Position (Balance Sheet)
      </h3>
      {balanced ? (
        <p className="text-xs text-green-500 mb-3">Balanced — Assets = Liabilities + Equity</p>
      ) : (
        <p className="text-xs text-red-400 mb-3">Out of balance by {formatCurrency(Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)))}</p>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BSSection label="Assets" color="blue" items={report.assets} total={report.totalAssets} />
        <div className="space-y-4">
          <BSSection label="Liabilities" color="amber" items={report.liabilities} total={report.totalLiabilities} />
          <BSSection label="Equity" color="purple" items={report.equity} total={report.totalEquity} />
        </div>
      </div>
    </section>
  );
}

// ── Income Statement ──────────────────────────────────────────────────────────

function ISSection({ label, items, total }: { label: string; items: IncomeStatementLineItem[]; total: number }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="border-b border-slate-100 dark:border-slate-800 last:border-0">
      <button
        type="button"
        onClick={() => setExpanded(p => !p)}
        className="w-full px-4 py-2 flex items-center justify-between bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-800 dark:text-slate-200">{formatCurrency(total)}</span>
          {expanded ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronRight className="w-3 h-3 text-slate-400" />}
        </span>
      </button>
      {expanded && items.map(item => (
        <div key={item.accountCode} className="px-4 py-1.5 flex justify-between text-sm">
          <span className="flex items-center gap-2 text-slate-600 dark:text-slate-400 pl-4">
            <span className="font-mono text-xs text-slate-400">{item.accountCode}</span>
            {item.accountName}
          </span>
          <span className="font-mono text-slate-700 dark:text-slate-300">{formatCurrency(item.amount)}</span>
        </div>
      ))}
    </div>
  );
}

function IncomeStatementBlock({ report, periodStart, periodEnd }: {
  report: IncomeStatementReport;
  periodStart: string;
  periodEnd: string;
}) {
  return (
    <section>
      <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wide mb-3 border-b border-slate-300 dark:border-slate-700 pb-1">
        Income Statement (Profit &amp; Loss)
      </h3>
      <p className="text-xs text-slate-500 mb-3">{periodStart} to {periodEnd}</p>
      <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
        <ISSection label="Revenue" items={report.revenue} total={report.totalRevenue} />
        {report.costOfSales.length > 0 && (
          <ISSection label="Cost of Sales" items={report.costOfSales} total={report.totalCostOfSales} />
        )}
        <div className="px-4 py-2 flex justify-between bg-teal-500/5">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Gross Profit</span>
          <span className={`font-mono font-bold text-sm ${report.grossProfit >= 0 ? 'text-teal-500' : 'text-red-400'}`}>
            {formatCurrency(report.grossProfit)}
          </span>
        </div>
        <ISSection label="Operating Expenses" items={report.operatingExpenses} total={report.totalOperatingExpenses} />
        <div className="px-4 py-3 flex justify-between bg-slate-100 dark:bg-slate-800">
          <span className="text-base font-bold text-slate-900 dark:text-white">Net Profit / (Loss)</span>
          <span className={`font-mono font-bold text-base ${report.netProfit >= 0 ? 'text-teal-500' : 'text-red-400'}`}>
            {formatCurrency(report.netProfit)}
          </span>
        </div>
      </div>
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
