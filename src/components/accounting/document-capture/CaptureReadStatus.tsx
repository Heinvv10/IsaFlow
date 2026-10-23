import { Loader2, AlertCircle } from 'lucide-react';

export const READ_FAILED_FALLBACK = 'The document could not be read — upload it again.';

interface Props {
  readState: 'reading' | 'done' | 'failed';
  readError: string | null;
}

/** What a captured document's background read is doing; nothing once it is done. */
export function CaptureReadStatus({ readState, readError }: Props) {
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
      </div>
    );
  }
  return null;
}
