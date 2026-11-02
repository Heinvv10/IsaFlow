/** BankPrimaryCard — one primary bank account in the bank-transactions card row (fixed 280px). */

import { formatCurrency as fmtCurrency } from '@/utils/formatters';
import type { BankAcct } from './BankTxBankCards';

export function BankPrimaryCard({ b, active, onSelect }: { b: BankAcct; active: boolean; onSelect: () => void }) {
  const gap = b.unreconciledBalance;
  const hasGap = Math.abs(gap) >= 0.01;
  return (
    <button
      data-testid="bank-account-card"
      onClick={onSelect}
      title={b.accountName}
      className={`h-full w-[280px] shrink-0 flex items-stretch gap-3 px-4 py-2.5 rounded-lg border-2 transition-all text-left ${
        active
          ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
          : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
      }`}
    >
      <div className={`w-2 rounded-full shrink-0 ${active ? 'bg-teal-500' : 'bg-[var(--ff-border-light)]'}`} />
      <div className="min-w-0 flex-1">
        <p className={`line-clamp-2 text-sm font-semibold leading-snug ${active ? 'text-teal-700 dark:text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
          {b.accountName}
        </p>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-[var(--ff-text-tertiary)] font-id">
            {b.accountCode}{b.bankAccountNumber && ` | ****${b.bankAccountNumber.slice(-4)}`}
          </span>
          <span className={`shrink-0 text-sm font-bold tabular-nums ${b.balance >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-300'}`}>
            {fmtCurrency(b.balance)}
          </span>
        </div>
        <div className="flex items-center justify-end gap-2 mt-0.5">
          <span className="text-xs text-teal-700 dark:text-teal-400 tabular-nums" title="Allocated to GL entries">
            ✓ {fmtCurrency(b.reconciledBalance)}
          </span>
          {hasGap && (
            <span
              className="text-xs text-amber-800 dark:text-amber-400 tabular-nums"
              title={`${b.unreconciledCount} unallocated transaction${b.unreconciledCount !== 1 ? 's' : ''}`}
            >
              Δ&nbsp;{fmtCurrency(Math.abs(gap))}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
