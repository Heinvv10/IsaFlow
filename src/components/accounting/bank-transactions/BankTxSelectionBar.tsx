/**
 * BankTxSelectionBar - "N selected" is always on screen (WP3), so a person always knows what a bulk action will touch;
 * it reads 0 when the list changed under the selection (page, tab, filter, account). Clear drops the selection.
 */

export function BankTxSelectionBar({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <div data-testid="bank-tx-selection-bar" role="status" aria-live="polite"
      className="flex items-center gap-3 px-6 py-1.5 text-xs border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]/40">
      <span data-testid="bank-tx-selected-count"
        className={count > 0 ? 'font-semibold text-teal-700 dark:text-teal-400' : 'text-[var(--ff-text-tertiary)]'}>
        {count} selected
      </span>
      {count > 0 && (
        <button type="button" onClick={onClear} data-testid="bank-tx-selection-clear"
          className="text-[var(--ff-text-secondary)] underline hover:text-[var(--ff-text-primary)]">
          Clear selection
        </button>
      )}
    </div>
  );
}
