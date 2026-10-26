/**
 * Tabs, pagination and the bottom bar of the bank transactions page. Moved out of the page unchanged.
 */
export type BankTxTab = 'new' | 'reviewed' | 'excluded';

export function BankTxTabs({ tab, setTab }: { tab: BankTxTab; setTab: (t: BankTxTab) => void }) {
  return (
  <div className="px-6 border-b border-[var(--ff-border-light)]">
    <div className="flex gap-0">
      {(['new', 'reviewed', 'excluded'] as BankTxTab[]).map(t => (
        <button key={t} onClick={() => setTab(t)}
          className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t ? (t === 'excluded' ? 'border-red-500 text-red-400' : 'border-teal-500 text-teal-400') : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
          {t === 'new' ? 'New Transactions' : t === 'excluded' ? 'Excluded' : 'Reviewed Transactions'}
        </button>
      ))}
    </div>
  </div>
  );
}

export function BankTxPagination({ page, total, pageSize, setPage }: { page: number; total: number; pageSize: number; setPage: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="px-6 py-3 border-t border-[var(--ff-border-light)] flex items-center justify-between">
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => setPage(1)} className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">First</button>
        {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
          const p = totalPages <= 10 ? i + 1 : page <= 5 ? i + 1 : page >= totalPages - 4 ? totalPages - 9 + i : page - 5 + i;
          return (
            <button key={p} onClick={() => setPage(p)}
              className={`w-7 h-7 rounded text-xs ${p === page ? 'bg-brand-600 text-white font-bold' : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'}`}>
              {p}
            </button>
          );
        })}
        <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">Last</button>
      </div>
      <span className="text-xs text-[var(--ff-text-tertiary)]">Displaying {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
    </div>
  );
}

export function BankTxBottomBar({ show, selectedCount, onAccept }: { show: boolean; selectedCount: number; onAccept: () => void }) {
  if (!show) return null;
  return (
    <div className="sticky bottom-0 bg-[var(--ff-bg-secondary)] border-t border-[var(--ff-border-light)] px-6 py-3 flex items-center justify-center">
      <button onClick={onAccept} disabled={selectedCount === 0}
        className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
        Mark Selected as Reviewed ({selectedCount})
      </button>
    </div>
  );
}
