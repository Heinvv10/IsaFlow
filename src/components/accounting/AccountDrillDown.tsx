/**
 * Reusable Account Transaction Drill-Down Panel
 * Lazy-loads transactions from the account-transactions API when rendered.
 * Used by Income Statement, Balance Sheet, Trial Balance, and Budget vs Actual.
 */

import { useState, useEffect } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { formatDisplayDate } from '@/utils/dateFormat';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtDate = (d: string) => {
  if (!d) return '—';
  // Handle YYYY-MM-DD strings by appending T00:00:00 to avoid timezone-shift issues
  const iso = d.length === 10 ? `${d}T00:00:00` : d;
  return formatDisplayDate(iso, d);
};

interface Transaction {
  date: string;
  entryNumber: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  source: string;
}

interface DrillDownData {
  accountCode: string;
  accountName: string;
  openingBalance: number;
  closingBalance: number;
  transactions: Transaction[];
}

interface AccountDrillDownProps {
  accountCode: string;
  periodStart: string;
  periodEnd: string;
  /** Render inside a <table> (uses <tr>/<td>) vs standalone (uses <div>) */
  asTableRow?: boolean;
  /** Column span when rendered as table row */
  colSpan?: number;
}

export function AccountDrillDown({
  accountCode,
  periodStart,
  periodEnd,
  asTableRow,
  colSpan = 5,
}: AccountDrillDownProps) {
  const [data, setData] = useState<DrillDownData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    const params = new URLSearchParams({
      account_code: accountCode,
      period_start: periodStart,
      period_end: periodEnd,
    });

    apiFetch(`/api/accounting/reports-account-transactions?${params}`)
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        const d = json.data || json;
        setData(d);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load transactions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [accountCode, periodStart, periodEnd]);

  const content = (
    <div className="bg-[var(--ff-bg-primary)] border-t border-[var(--ff-border-light)]">
      {loading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-tertiary)]" />
          <span className="ml-2 text-xs text-[var(--ff-text-tertiary)]">Loading transactions...</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      ) : data && data.transactions.length === 0 ? (
        <div className="px-4 py-3 text-xs text-[var(--ff-text-tertiary)]">
          No transactions in this period
        </div>
      ) : data ? (
        <div>
          {/* Opening balance */}
          <div className="px-4 py-1.5 flex items-center justify-between text-xs bg-[var(--ff-bg-tertiary)]/50 border-b border-[var(--ff-border-light)]">
            <span className="text-[var(--ff-text-tertiary)] font-medium">Opening Balance</span>
            <span className="font-mono text-[var(--ff-text-secondary)]">{fmt(data.openingBalance)}</span>
          </div>

          {/* Column headers */}
          <div className="px-4 py-1 flex items-center gap-3 text-[10px] uppercase tracking-wider text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/30">
            <span className="w-20">Date</span>
            <span className="w-24">Entry #</span>
            <span className="flex-1">Description</span>
            <span className="w-24 text-right">Debit</span>
            <span className="w-24 text-right">Credit</span>
            <span className="w-24 text-right">Balance</span>
          </div>

          {/* Transaction rows */}
          {data.transactions.map((tx, i) => (
            <div
              key={`${tx.entryNumber}-${i}`}
              className="px-4 py-1 flex items-center gap-3 text-xs border-b border-[var(--ff-border-light)]/40 hover:bg-[var(--ff-bg-tertiary)]/20"
            >
              <span className="w-20 text-[var(--ff-text-tertiary)]">{fmtDate(tx.date)}</span>
              <span className="w-24 font-mono text-[var(--ff-text-secondary)]">{tx.entryNumber}</span>
              <span className="flex-1 text-[var(--ff-text-secondary)] truncate">{tx.description}</span>
              <span className="w-24 text-right font-mono text-[var(--ff-text-primary)]">
                {tx.debit > 0 ? fmt(tx.debit) : ''}
              </span>
              <span className="w-24 text-right font-mono text-[var(--ff-text-primary)]">
                {tx.credit > 0 ? fmt(tx.credit) : ''}
              </span>
              <span className="w-24 text-right font-mono text-[var(--ff-text-secondary)]">
                {fmt(tx.balance)}
              </span>
            </div>
          ))}

          {/* Closing balance */}
          <div className="px-4 py-1.5 flex items-center justify-between text-xs bg-[var(--ff-bg-tertiary)]/50 border-t border-[var(--ff-border-light)]">
            <span className="text-[var(--ff-text-tertiary)] font-medium">
              Closing Balance ({data.transactions.length} transaction{data.transactions.length !== 1 ? 's' : ''})
            </span>
            <span className="font-mono font-medium text-[var(--ff-text-primary)]">{fmt(data.closingBalance)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (asTableRow) {
    return (
      <tr>
        <td colSpan={colSpan} className="p-0">{content}</td>
      </tr>
    );
  }

  return content;
}
