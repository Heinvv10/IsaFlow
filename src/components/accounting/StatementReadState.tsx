/**
 * StatementReadState — what a bank or supplier statement shows while it is being read in the
 * background ("Reading statement…", with the page count once known) and when the read failed
 * (why, with Retry unless the statement is too long to ever be read, and Delete).
 */

import { Loader2, AlertCircle, RotateCcw, Trash2 } from 'lucide-react';

const BTN = 'flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors';

export function StatementReading({ pagesDone, pagesTotal }: { pagesDone: number | null; pagesTotal: number | null }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
      <p className="text-sm font-medium text-[var(--ff-text-primary)]">Reading statement…</p>
      <p className="text-xs text-[var(--ff-text-tertiary)]">
        {pagesTotal ? `Page ${Math.min((pagesDone ?? 0) + 1, pagesTotal)} of ${pagesTotal}. ` : ''}
        This can take a few minutes. You can leave this page; the statement stays in the list.
      </p>
    </div>
  );
}

interface FailedProps {
  error: string | null;
  retryable: boolean;
  busy: boolean;
  onRetry: () => void;
  onDelete: () => void;
}

export function StatementReadFailed({ error, retryable, busy, onRetry, onDelete }: FailedProps) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] border border-red-500/30 rounded-lg p-5 space-y-4">
      <div role="alert" className="flex items-start gap-2 text-sm text-red-400">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>{error ?? 'The statement could not be read. Retry the import.'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {retryable && (
          <button onClick={onRetry} disabled={busy}
            className={`${BTN} bg-indigo-600 hover:bg-indigo-700 text-white`}>
            <RotateCcw className="h-4 w-4" /> Retry
          </button>
        )}
        <button onClick={onDelete} disabled={busy}
          className={`${BTN} border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]`}>
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      </div>
    </div>
  );
}
