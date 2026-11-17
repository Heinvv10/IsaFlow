/** BankPrimaryCard — one primary bank account in the bank-transactions card row (fixed 280px). */

import { Check } from 'lucide-react';
import { fmtCents } from './bankCents';
import { ToCodeLine } from './ToCodeLine';
import { MiddleTruncate } from './MiddleTruncate';
import type { BankAccountSummary } from './useBankTxSummary';

export function BankPrimaryCard({ b, active, onSelect }: { b: BankAccountSummary; active: boolean; onSelect: () => void }) {
  return (
    <button
      data-testid="bank-account-card"
      onClick={onSelect}
      title={b.accountName}
      aria-current={active ? 'true' : undefined}
      className={`h-full w-[280px] shrink-0 flex items-stretch gap-3 px-4 py-1.5 rounded-lg border-2 transition-all text-left ${
        active
          ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
          : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
      } ${b.isActive ? '' : 'opacity-70'}`}
    >
      <div className={`w-2 rounded-full shrink-0 ${active ? 'bg-teal-500' : 'bg-[var(--ff-border-light)]'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          {/* The selected card is marked by a check as well as by colour (aria-current says it to a screen reader). */}
          {active && <Check data-testid="card-selected-mark" aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-teal-700 dark:text-teal-400" />}
          <MiddleTruncate name={b.accountName} testId="card-name"
            className={`text-sm font-semibold leading-snug ${active ? 'text-teal-700 dark:text-teal-400' : 'text-[var(--ff-text-primary)]'}`} />
          {!b.isActive && (
            <span data-testid="card-inactive-chip"
              className="shrink-0 rounded-full bg-[var(--ff-bg-tertiary)] px-2 py-0.5 text-xs font-medium text-[var(--ff-text-secondary)]">
              Inactive
            </span>
          )}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-[var(--ff-text-tertiary)] font-id">
            {b.accountCode}{b.bankAccountNumber && ` | ****${b.bankAccountNumber.slice(-4)}`}
          </span>
          <span data-testid="card-ledger" title={`Ledger balance as at ${b.ledgerAsAt}`}
            className={`shrink-0 text-sm font-bold tabular-nums ${b.ledgerCents >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-300'}`}>
            Ledger {fmtCents(b.ledgerCents)}
          </span>
        </div>
        <div className="mt-0.5">
          <ToCodeLine toCode={b.counts.toCode} inCents={b.toCodeInCents} outCents={b.toCodeOutCents} />
        </div>
      </div>
    </button>
  );
}
