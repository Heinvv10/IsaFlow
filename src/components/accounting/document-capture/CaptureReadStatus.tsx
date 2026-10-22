import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';

export const READ_FAILED_FALLBACK = 'The document could not be read — upload it again.';

interface Props {
  readState: 'reading' | 'done' | 'failed';
  readError: string | null;
  /** The failed read can be re-run from the stored file; with `onRetry` the panel offers a Retry button. */
  retryable?: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
}

/** What a captured document's background read is doing; nothing once it is done. */
export function CaptureReadStatus({ readState, readError, retryable, onRetry, isRetrying }: Props) {
  if (readState === 'reading') {
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-teal-500/20 bg-teal-500/5 px-6 py-4">
        <Loader2 className="h-5 w-5 mt-0.5 shrink-0 text-teal-500 animate-spin" />
        <div>
          <p className="text-sm font-medium text-[var(--ff-text-primary)]">Reading document…</p>
          <p className="text-xs text-[var(--ff-text-secondary)]">
            This can take a minute or two. You can leave this page; it stays in the list.
          </p>
        </div>
      </div>
    );
  }
  if (readState === 'failed') {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-6 py-4">
        <AlertCircle className="h-5 w-5 mt-0.5 shrink-0 text-red-400" />
        <p className="text-sm text-red-400">{readError || READ_FAILED_FALLBACK}</p>
        {retryable && onRetry && (
          <button type="button" onClick={onRetry} disabled={isRetrying}
            className="ml-auto shrink-0 inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${isRetrying ? 'animate-spin' : ''}`} /> Retry
          </button>
        )}
      </div>
    );
  }
  return null;
}
