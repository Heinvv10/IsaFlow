/**
 * Statement Balance Widget
 * Displays the latest bank statement import batch balances alongside the
 * current GL balance, highlighting any discrepancy between them.
 */

'use client';

import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, CalendarDays, Hash } from 'lucide-react';

// 🟢 WORKING: ZAR currency formatter (2 decimal places for reconciliation context)
const fmt = (amount: number): string =>
  new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

interface ImportBatch {
  id: string;
  statementDate: string;
  bankFormat: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  transactionCount: number;
  createdAt: string;
}

interface Props {
  /** UUID of the bank account (gl_accounts.id with account_subtype = 'bank') */
  bankAccountId: string;
  /** Current GL balance to compare against the statement closing balance */
  glBalance?: number;
}

// 🟢 WORKING: Statement Balance Widget
export function StatementBalanceWidget({ bankAccountId, glBalance }: Props) {
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!bankAccountId) return;

    let cancelled = false;
    setLoading(true);
    setError('');

    fetch(
      `/api/accounting/bank-import-batches?bankAccountId=${encodeURIComponent(bankAccountId)}`,
      { credentials: 'include' }
    )
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        const batches: ImportBatch[] = json?.data?.batches ?? [];
        setBatch(batches[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load statement data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [bankAccountId]);

  if (loading) {
    return (
      <div
        className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4"
        style={{ minHeight: 100 }}
      >
        <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading statement balances…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4">
        <div className="flex items-center gap-2 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      </div>
    );
  }

  if (!batch) {
    return (
      <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4">
        <p className="text-xs text-[var(--ff-text-tertiary)]">No statement imports found.</p>
      </div>
    );
  }

  const difference =
    batch.closingBalance !== null && glBalance !== undefined
      ? batch.closingBalance - glBalance
      : null;

  const isReconciled = difference !== null && Math.abs(difference) < 0.01;

  // Format the import date for display
  const importedOn = new Date(batch.createdAt).toLocaleDateString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--ff-border-light)] px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">
          Statement Balance
        </h3>
        {batch.bankFormat && (
          <span className="rounded-full bg-[var(--ff-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--ff-text-tertiary)]">
            {batch.bankFormat.toUpperCase()}
          </span>
        )}
      </div>

      {/* Balance rows */}
      <div className="divide-y divide-[var(--ff-border-light)]">
        {/* Opening Balance */}
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-xs text-[var(--ff-text-tertiary)]">Opening Balance</span>
          <span className="font-mono text-sm text-[var(--ff-text-primary)]">
            {batch.openingBalance !== null ? fmt(batch.openingBalance) : '—'}
          </span>
        </div>

        {/* Closing Balance */}
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-xs text-[var(--ff-text-tertiary)]">Closing Balance</span>
          <span className="font-mono text-sm font-medium text-[var(--ff-text-primary)]">
            {batch.closingBalance !== null ? fmt(batch.closingBalance) : '—'}
          </span>
        </div>

        {/* GL Balance */}
        {glBalance !== undefined && (
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs text-[var(--ff-text-tertiary)]">GL Balance</span>
            <span className="font-mono text-sm text-[var(--ff-text-primary)]">
              {fmt(glBalance)}
            </span>
          </div>
        )}

        {/* Difference */}
        {difference !== null && (
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-xs text-[var(--ff-text-tertiary)]">
              {isReconciled
                ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                : <AlertCircle className="h-3.5 w-3.5 text-amber-400" />}
              Difference
            </span>
            <span
              className={`font-mono text-sm font-semibold ${
                isReconciled ? 'text-emerald-500' : 'text-amber-400'
              }`}
            >
              {isReconciled ? fmt(0) : fmt(difference)}
            </span>
          </div>
        )}
      </div>

      {/* Footer: import metadata */}
      <div className="flex items-center gap-4 border-t border-[var(--ff-border-light)] px-4 py-2 text-[10px] text-[var(--ff-text-tertiary)]">
        <span className="flex items-center gap-1">
          <CalendarDays className="h-3 w-3" />
          {batch.statementDate}
        </span>
        <span className="flex items-center gap-1">
          <Hash className="h-3 w-3" />
          {batch.transactionCount} transactions
        </span>
        <span className="ml-auto">Imported {importedOn}</span>
      </div>
    </div>
  );
}

export default StatementBalanceWidget;
