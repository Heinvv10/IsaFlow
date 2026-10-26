/** BankTxPagination — First / ten page numbers around the current page / Last, and the row range shown; plus the page's review footer. */

interface Props {
  page: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}

export function BankTxPagination({ page, total, pageSize, onPage }: Props) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  return (
    <div className="px-6 py-3 border-t border-[var(--ff-border-light)] flex items-center justify-between">
      <div className="flex items-center gap-1">
        <button disabled={page <= 1} onClick={() => onPage(1)} className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">First</button>
        {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
          const p = totalPages <= 10 ? i + 1 : page <= 5 ? i + 1 : page >= totalPages - 4 ? totalPages - 9 + i : page - 5 + i;
          return (
            <button key={p} onClick={() => onPage(p)}
              className={`w-7 h-7 rounded text-xs ${p === page ? 'bg-brand-600 text-white font-bold' : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'}`}>
              {p}
            </button>
          );
        })}
        <button disabled={page >= totalPages} onClick={() => onPage(totalPages)} className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">Last</button>
      </div>
      <span className="text-xs text-[var(--ff-text-tertiary)]">Displaying {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
    </div>
  );
}

/** The sticky footer on the New tab: mark the selected rows as reviewed. */
export function BankTxReviewBar({ selectedCount, onReview }: { selectedCount: number; onReview: () => void }) {
  return (
    <div className="sticky bottom-0 bg-[var(--ff-bg-secondary)] border-t border-[var(--ff-border-light)] px-6 py-3 flex items-center justify-center">
      <button onClick={onReview} disabled={selectedCount === 0}
        className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
        Mark Selected as Reviewed ({selectedCount})
      </button>
    </div>
  );
}
