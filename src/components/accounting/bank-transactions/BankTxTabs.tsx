/**
 * BankTxTabs — New / Reviewed / Excluded, plus Provisional while the account has provisional lines (or it is the
 * open tab). A provisional line's cash is booked by its provisional journal, so it is on no other tab (PR #1475
 * round 3); the Allocated tile's "incl. n provisional" opens this one.
 */

export type BankTxTab = 'new' | 'reviewed' | 'excluded' | 'provisional';

const LABEL: Record<BankTxTab, string> = {
  new: 'New Transactions', reviewed: 'Reviewed Transactions', excluded: 'Excluded', provisional: 'Provisional',
};

interface Props {
  tab: BankTxTab;
  onTab: (t: BankTxTab) => void;
  /** The account's provisional lines (summary counts.provisional); the tab shows while > 0 or while open. */
  provisionalCount?: number;
}

export function BankTxTabs({ tab, onTab, provisionalCount = 0 }: Props) {
  const tabs: BankTxTab[] = ['new', 'reviewed', 'excluded'];
  if (provisionalCount > 0 || tab === 'provisional') tabs.push('provisional');
  return (
    <div className="px-6 border-b border-[var(--ff-border-light)]">
      <div className="flex gap-0" role="tablist" aria-label="Transaction status">
        {tabs.map(t => (
          <button key={t} onClick={() => onTab(t)} data-testid={`bank-tx-tab-${t}`} role="tab" aria-selected={tab === t}
            className={`px-5 py-2.5 text-sm border-b-2 transition-colors ${tab === t ? 'font-semibold' : 'font-medium'} ${tab === t ? (t === 'excluded' ? 'border-red-500 text-red-700 dark:text-red-400' : 'border-teal-500 text-teal-700 dark:text-teal-400') : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
            {LABEL[t]}{t === 'provisional' && provisionalCount > 0 ? ` (${provisionalCount})` : ''}
          </button>
        ))}
      </div>
    </div>
  );
}
