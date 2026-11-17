/**
 * BankTxSelectionBar - the contextual selection bar (WP4b). The toolbar draws it only while rows are ticked, in its own
 * row in place of the page actions (so ticking a row moves nothing on screen), and carries everything that acts on the
 * selection: Mark as Reviewed (which replaced the floating "Mark Selected as Reviewed" that covered the last rows),
 * Batch Allocate, Batch Edit, Delete and Clear selection. "N selected" is announced by BankTxSelectionLive, which is
 * always mounted (WP3: the count reads 0 as soon as the list changes under the selection).
 */

import { CheckCheck, Layers, Loader2, Trash2, X } from 'lucide-react';
import { isBulkBusy } from './useBankTxBusy';

interface Props {
  count: number;
  /** The selection actions are the New tab's: elsewhere the bar only counts and clears. */
  showActions: boolean;
  busy?: ReadonlySet<string>;
  progress?: { key: string; done: number; total: number } | null;
  onBulkAccept: () => void;
  onBatchAccept: () => void;
  onBatchDelete: () => void;
  onToggleBatchEdit: () => void;
  onClear: () => void;
}

const BTN = 'flex min-h-7 items-center gap-1 rounded px-2 text-xs disabled:opacity-40';

/** "N selected" for a screen reader, mounted whether or not anything is selected. */
export function BankTxSelectionLive({ count }: { count: number }) {
  return <span role="status" aria-live="polite" data-testid="bank-tx-selection-live" className="sr-only">{count} selected</span>;
}

export function BankTxSelectionBar({ count, showActions, busy, progress, onBulkAccept, onBatchAccept, onBatchDelete, onToggleBatchEdit, onClear }: Props) {
  // The three bulk operations act on the same selected lines: while one runs, the others wait (the hook refuses them too).
  const bulkBusy = isBulkBusy(busy);
  return (
    <div data-testid="bank-tx-selection-bar" className="flex flex-wrap items-center gap-1.5 rounded-md bg-teal-500/10 px-2 py-0.5">
      <span data-testid="bank-tx-selected-count" className="px-1 text-xs font-semibold text-teal-700 dark:text-teal-400">{count} selected</span>
      {showActions && (
        <>
          <button type="button" onClick={onBulkAccept} disabled={bulkBusy} aria-busy={busy?.has('review') || undefined}
            className={`${BTN} font-medium text-teal-700 dark:text-teal-400 hover:bg-teal-500/15`}>
            {busy?.has('review') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />} Mark as Reviewed
          </button>
          <button type="button" onClick={onBatchAccept} disabled={bulkBusy} aria-busy={busy?.has('batch-allocate') || undefined}
            className={`${BTN} text-teal-700 dark:text-teal-400 hover:bg-teal-500/15`}>
            {busy?.has('batch-allocate') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
            {progress?.key === 'batch-allocate' ? ` Allocating ${progress.done + 1} of ${progress.total}` : ' Batch Allocate'}
          </button>
          <button type="button" onClick={onToggleBatchEdit}
            className={`${BTN} text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]`}>
            <Layers className="h-3.5 w-3.5" /> Batch Edit
          </button>
          <span aria-hidden="true" className="mx-0.5 h-4 border-l border-[var(--ff-border-light)]" />
          <button type="button" onClick={onBatchDelete} disabled={bulkBusy} aria-busy={busy?.has('delete') || undefined}
            className={`${BTN} text-red-700 dark:text-red-400 hover:bg-red-500/10`}>
            {busy?.has('delete') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
          </button>
        </>
      )}
      <button type="button" onClick={onClear} data-testid="bank-tx-selection-clear"
        className={`${BTN} text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]`}>
        <X className="h-3.5 w-3.5" /> Clear selection
      </button>
    </div>
  );
}
