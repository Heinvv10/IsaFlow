/**
 * Bulk accept of high-confidence suggestions (WP6, decision 2a.2): preview the rows, confirm in one request, see what was
 * posted and what was refused (with the reason), and undo exactly that batch.
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { BankTxModalShell } from '../BankTxModalShell';
import { partialUndoMessage } from '../AutoPostRunsPanel';
import { HandOffsetNotice, type HandOffset } from '../HandOffsetNotice';
import { useBulkAccept } from './useBulkAccept';
import { BulkPreviewBody } from './BulkPreviewBody';

interface Props { open: boolean; bankAccountId: string | null; onClose: () => void; onChanged: () => void }

export function BulkAcceptModal({ open, bankAccountId, onClose, onChanged }: Props) {
  const { state, load, confirm, undo, reset, handOffDecided } = useBulkAccept(bankAccountId);
  const { phase, preview, refreshing, confirmed, undone, names, error, tokenDead, retrying, changed } = state;
  useEffect(() => { if (open) void load(); else reset(); }, [open, load, reset]);
  const working = phase === 'confirming' || phase === 'undoing';
  // A confirm or undo in flight cannot be closed over: its answer (what posted, the batch to undo) would be lost.
  const close = () => { if (working) return; if (changed) onChanged(); onClose(); };
  if (!open) return null;
  const lines = preview?.lines ?? [];
  const busy = phase === 'loading' || working || refreshing;
  const refused = confirmed?.refused ?? [];
  const more = !!preview && (preview.truncated || preview.scanTruncated);
  const canUndo = !!confirmed?.runId && !undone?.undone;

  const title = phase === 'result' || phase === 'undoing' ? 'High-confidence suggestions: result' : `Accept ${lines.length} high-confidence suggestion${lines.length === 1 ? '' : 's'}`;

  // The page's one modal shell (WP7). `busy` is the raw in-flight flag, not useModalBusy's 30 s release: the confirm and undo
  // bound their own wait (CONFIRM_RETRY, then "may have posted"), and closing over one in flight would lose its answer.
  // Focus lands on a control that is always enabled (`data-autofocus`: Cancel while previewing, Done on the result), never on
  // a disabled Confirm.
  return (
    <BankTxModalShell label={title} onClose={close} busy={working} closeOnBackdrop>
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--ff-border-light)] px-6 py-4">
          <h2 className="pr-4 text-lg font-semibold text-[var(--ff-text-primary)]">{title}</h2>
          <button type="button" onClick={close} disabled={working} aria-label="Close modal"
            className="shrink-0 rounded p-1 text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-primary)] hover:text-[var(--ff-text-primary)] disabled:opacity-50">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div role="status" aria-live="polite" className={retrying ? 'mb-3 text-sm text-amber-300' : 'sr-only'}>
            {retrying ? 'Still trying - the connection is slow or dropped. Sending the same request again; it cannot post twice.' : busy ? 'Working' : ''}
          </div>
          {error && (
            <div role="alert" className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <p>{error}</p>
              {tokenDead && phase === 'preview' && (
                <button type="button" onClick={() => void load()} className="mt-1 underline">Refresh preview</button>
              )}
            </div>
          )}
          {phase === 'loading' && <p className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">Loading suggestions…</p>}
          {(phase === 'preview' || phase === 'confirming') && preview && (
            <BulkPreviewBody preview={preview} busy={busy} onNextPage={() => void load(preview.nextScanAfter, true)} />
          )}
          {(phase === 'result' || phase === 'undoing') && confirmed && (
            <div>
              <p className="text-sm text-[var(--ff-text-primary)]" data-testid="bulk-result">
                Posted {confirmed.posted.length} line{confirmed.posted.length === 1 ? '' : 's'} ({formatMoney(confirmed.totalPosted)}).
                {refused.length > 0 && ` ${refused.length} not posted.`}
              </p>
              {refused.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm" aria-label="Lines not posted">
                  {refused.map((r) => (
                    <li key={r.txId} className="rounded bg-amber-500/10 px-3 py-1.5 text-amber-200">
                      <span className="font-medium">{names.get(r.txId) ?? r.txId}</span>: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
              {undone && (
                <p role="status" className="mt-3 text-sm text-emerald-300">
                  {undone.undone ? `Batch undone: ${undone.reversed} line${undone.reversed === 1 ? '' : 's'} reversed.` : partialUndoMessage(undone)}
                </p>
              )}
              {undone && undone.handOffsets.length > 0 && confirmed.runId && (
                <ul aria-label="Lines a later journal may already correct" className="mt-2 space-y-2">
                  {(undone.handOffsets as unknown as HandOffset[]).map((o) => (
                    <HandOffsetNotice key={o.transactionId} runId={confirmed.runId!} offset={o} onDecided={handOffDecided} />
                  ))}
                </ul>
              )}
              {canUndo && !undone && <p className="mt-3 text-xs text-[var(--ff-text-tertiary)]">Undo reverses exactly this batch. It stays available later under Auto-post runs.</p>}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-[var(--ff-border-light)] px-6 py-4">
          {(phase === 'idle' || phase === 'preview' || phase === 'confirming' || phase === 'loading') && (
            <>
              <button type="button" data-autofocus onClick={close} disabled={working} className="rounded px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
              <button type="button" onClick={() => void confirm()} disabled={busy || tokenDead || lines.length === 0 || !preview?.previewToken}
                aria-busy={phase === 'confirming' || undefined} className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {phase === 'confirming' ? 'Posting…' : `Confirm and post ${lines.length}`}
              </button>
            </>
          )}
          {(phase === 'result' || phase === 'undoing') && (
            <>
              {canUndo && (
                <button type="button" onClick={() => void undo()} disabled={busy} aria-busy={phase === 'undoing' || undefined}
                  className="rounded border border-red-500/50 px-4 py-2 text-sm text-red-300 disabled:opacity-50">
                  {phase === 'undoing' ? 'Undoing…' : undone ? 'Undo the rest of the batch' : 'Undo batch'}
                </button>
              )}
              {more && !undone && (
                <button type="button" onClick={() => void load()} disabled={busy} className="rounded px-4 py-2 text-sm text-[var(--ff-text-secondary)] underline">Preview the next batch</button>
              )}
              <button type="button" data-autofocus onClick={close} disabled={working} className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white">Done</button>
            </>
          )}
        </div>
      </div>
    </BankTxModalShell>
  );
}
