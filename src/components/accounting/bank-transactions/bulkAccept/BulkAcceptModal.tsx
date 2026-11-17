/**
 * Bulk accept of high-confidence suggestions (WP6, decision 2a.2): preview the rows, confirm in one request, see what was
 * posted and what was refused (with the reason), and undo exactly that batch.
 */
import { useEffect, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { formatMoney } from '@/lib/money/formatMoney';
import { partialUndoMessage } from '../AutoPostRunsPanel';
import { HandOffsetNotice, type HandOffset } from '../HandOffsetNotice';
import { useBulkAccept } from './useBulkAccept';
import { BulkPreviewBody } from './BulkPreviewBody';

interface Props { open: boolean; bankAccountId: string | null; onClose: () => void; onChanged: () => void }

export function BulkAcceptModal({ open, bankAccountId, onClose, onChanged }: Props) {
  const { state, load, confirm, undo, reset, handOffDecided } = useBulkAccept(bankAccountId);
  const { phase, preview, refreshing, confirmed, undone, names, error, tokenDead, retrying, changed } = state;
  // Focus lands on a control that is always enabled (Cancel while previewing, Done on the result), never on a disabled Confirm.
  const focusRef = useRef<HTMLButtonElement>(null);
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

  return (
    <Modal open onClose={close} size="xl" initialFocusRef={focusRef}
      title={phase === 'result' || phase === 'undoing' ? 'High-confidence suggestions: result' : `Accept ${lines.length} high-confidence suggestion${lines.length === 1 ? '' : 's'}`}>
      <Modal.Body>
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
      </Modal.Body>
      <Modal.Footer>
        {(phase === 'idle' || phase === 'preview' || phase === 'confirming' || phase === 'loading') && (
          <>
            <button type="button" ref={focusRef} onClick={close} disabled={working} className="rounded px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
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
            <button type="button" ref={focusRef} onClick={close} disabled={working} className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white">Done</button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
