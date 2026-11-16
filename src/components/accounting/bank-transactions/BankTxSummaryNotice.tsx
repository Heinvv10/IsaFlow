/**
 * BankTxSummaryNotice — the bank-account summary failed. A failed FIRST load is an error with Retry (never the
 * "No bank accounts configured" empty state, which would tell a user with accounts that they have none); a failed
 * later load leaves the last figures on screen with an inline "may be out of date" note.
 */

import { AlertCircle } from 'lucide-react';

interface Props {
  /** 'error': nothing loaded yet. 'stale': a refresh failed after a good load. */
  kind: 'error' | 'stale';
  message?: string;
  onRetry: () => void;
}

export function BankTxSummaryNotice({ kind, message, onRetry }: Props) {
  const retry = (
    <button type="button" onClick={onRetry} data-testid="bank-summary-retry"
      className="rounded-md border border-teal-700 px-3 py-1 text-xs font-medium text-teal-800 hover:bg-teal-700/10 dark:border-teal-400 dark:text-teal-300">
      Retry
    </button>
  );
  if (kind === 'stale') {
    return (
      <p role="status" data-testid="bank-summary-stale"
        className="flex items-center gap-3 border-b border-[var(--ff-border-light)] px-6 py-1.5 text-xs text-amber-700 dark:text-amber-400">
        Figures may be out of date · {retry}
      </p>
    );
  }
  return (
    <div role="alert" data-testid="bank-summary-error" className="mx-6 my-6 flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{message || 'Could not load the bank accounts - try again'}</span>
      {retry}
    </div>
  );
}
