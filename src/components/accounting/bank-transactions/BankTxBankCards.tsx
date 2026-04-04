/**
 * BankTxBankCards — Bank account selector cards + balance stats header.
 * Renders one card per bank account; active card is highlighted in teal.
 */

import { StatementBalanceWidget } from '@/components/accounting/StatementBalanceWidget';
import { formatCurrency as fmtCurrency } from '@/utils/formatters';

export interface BankAcct {
  id: string;
  accountCode: string;
  accountName: string;
  bankAccountNumber?: string | null;
  balance: number;
  reconciledBalance: number;
  unreconciledBalance: number;
  unreconciledCount: number;
  allocatedCount: number;
  unallocatedCount: number;
}

type Tab = 'new' | 'reviewed' | 'excluded';

interface Props {
  bankAccounts: BankAcct[];
  selectedBank: string;
  tab: Tab;
  total: number;
  onSelectBank: (id: string) => void;
}

export function BankTxBankCards({ bankAccounts, selectedBank, tab, total, onSelectBank }: Props) {
  const bank = bankAccounts.find(b => b.id === selectedBank);

  return (
    <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
      <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-3">Banking</h1>
      <div className="flex items-center gap-3 flex-wrap">
        {bankAccounts.map(b => {
          const active = b.id === selectedBank;
          const gap = b.unreconciledBalance;
          const hasGap = Math.abs(gap) >= 0.01;
          return (
            <button
              key={b.id}
              onClick={() => onSelectBank(b.id)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border-2 transition-all text-left ${
                active
                  ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
                  : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
              }`}
            >
              <div className={`w-2 h-14 rounded-full shrink-0 ${active ? 'bg-teal-500' : 'bg-[var(--ff-border-light)]'}`} />
              <div>
                <p className={`text-sm font-semibold ${active ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
                  {b.accountName}
                </p>
                <p className="text-xs text-[var(--ff-text-tertiary)] font-mono">
                  {b.accountCode}
                  {b.bankAccountNumber && <span className="ml-1.5">| ****{b.bankAccountNumber.slice(-4)}</span>}
                </p>
              </div>
              <div className="ml-3 text-right">
                <p className={`text-sm font-bold font-mono ${b.balance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                  {fmtCurrency(b.balance)}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-teal-500/80 font-mono" title="Allocated to GL entries">
                    ✓ {fmtCurrency(b.reconciledBalance)}
                  </span>
                  {hasGap && (
                    <span
                      className="text-[10px] text-amber-400 font-mono"
                      title={`${b.unreconciledCount} unallocated transaction${b.unreconciledCount !== 1 ? 's' : ''}`}
                    >
                      Δ {fmtCurrency(Math.abs(gap))}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}

        {bank && (
          <div className="ml-auto flex items-center gap-4">
            <StatementBalanceWidget bankAccountId={selectedBank} glBalance={bank.balance} />
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-2xl font-bold text-teal-400">{bank.allocatedCount}</p>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Allocated</p>
              </div>
              <div className="w-px h-8 bg-[var(--ff-border-light)]" />
              <div className="text-right">
                <p className="text-2xl font-bold text-amber-400">{bank.unallocatedCount}</p>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Unallocated</p>
              </div>
              <div className="w-px h-8 bg-[var(--ff-border-light)]" />
              <div className="text-right">
                <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{total}</p>
                <p className="text-xs text-[var(--ff-text-tertiary)]">
                  {tab === 'new' ? 'To be Reviewed' : tab === 'excluded' ? 'Excluded' : 'Reviewed'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
