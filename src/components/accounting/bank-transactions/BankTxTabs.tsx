/** BankTxTabs — New / Reviewed / Excluded. */

export type BankTxTab = 'new' | 'reviewed' | 'excluded';

export function BankTxTabs({ tab, onTab }: { tab: BankTxTab; onTab: (t: BankTxTab) => void }) {
  return (
    <div className="px-6 border-b border-[var(--ff-border-light)]">
      <div className="flex gap-0">
        {(['new', 'reviewed', 'excluded'] as BankTxTab[]).map(t => (
          <button key={t} onClick={() => onTab(t)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t ? (t === 'excluded' ? 'border-red-500 text-red-400' : 'border-teal-500 text-teal-400') : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
            {t === 'new' ? 'New Transactions' : t === 'excluded' ? 'Excluded' : 'Reviewed Transactions'}
          </button>
        ))}
      </div>
    </div>
  );
}
