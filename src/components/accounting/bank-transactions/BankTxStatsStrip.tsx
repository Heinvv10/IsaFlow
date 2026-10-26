/**
 * BankTxStatsStrip — the selected account's statement balance and allocation
 * counts, full width directly above the tabs. They used to share the cards
 * row, where many accounts pushed them onto a line of their own anyway.
 */

import { StatementBalanceWidget } from '@/components/accounting/StatementBalanceWidget';
import type { BankAcct } from './BankTxBankCards';

type Tab = 'new' | 'reviewed' | 'excluded';

interface Props {
  bank: BankAcct;
  tab: Tab;
  total: number;
}

function Stat({ value, label, className }: { value: number; label: string; className: string }) {
  return (
    <div className="min-w-[6.5rem] rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-4 py-3">
      <p className={`text-2xl font-bold tabular-nums ${className}`}>{value}</p>
      <p className="text-xs text-[var(--ff-text-secondary)]">{label}</p>
    </div>
  );
}

export function BankTxStatsStrip({ bank, tab, total }: Props) {
  return (
    <div data-testid="bank-tx-stats-strip" className="mt-4 flex flex-wrap items-stretch gap-4">
      <div className="w-full sm:w-[360px] shrink-0">
        <StatementBalanceWidget bankAccountId={bank.id} glBalance={bank.balance} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-3">
        <p className="truncate text-sm text-[var(--ff-text-secondary)]" title={bank.accountName}>
          <span className="font-semibold text-[var(--ff-text-primary)]">{bank.accountName}</span>
          <span className="ml-2 font-mono text-xs">{bank.accountCode}</span>
        </p>
        <div className="flex flex-wrap gap-3">
          <Stat value={bank.allocatedCount} label="Allocated" className="text-teal-700 dark:text-teal-400" />
          <Stat value={bank.suggestedCount ?? 0} label="Suggested" className="text-sky-700 dark:text-sky-400" />
          <Stat value={bank.unallocatedCount} label="Unallocated" className="text-amber-800 dark:text-amber-400" />
          <Stat value={total} label={tab === 'new' ? 'To be Reviewed' : tab === 'excluded' ? 'Excluded' : 'Reviewed'}
            className="text-[var(--ff-text-primary)]" />
        </div>
      </div>
    </div>
  );
}
