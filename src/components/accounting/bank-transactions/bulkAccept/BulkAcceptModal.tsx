/**
 * Bulk accept of high-confidence suggestions (WP6, decision 2a.2): preview the rows, confirm in one request, see what was
 * posted and what was refused (with the reason), and undo exactly that batch.
 */
import { useEffect, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { formatMoney } from '@/lib/money/formatMoney';
import { partialUndoMessage } from '../AutoPostRunsPanel';
import { useBulkAccept } from './useBulkAccept';
import type { BulkPreview } from './bulkAcceptApi';

const EXCLUDED_LABELS: Record<keyof BulkPreview['excluded'], string> = {
  badTarget: 'target account cannot take a posting', reconciliationHeld: 'held by a reconciliation', periodClosed: 'in a closed period',
  noPeriod: 'in a month with no period', vatLocked: 'in a locked VAT period', vatCode: 'VAT code refused',
};

export function excludedSummary(excluded: BulkPreview['excluded']): string {
  return (Object.keys(EXCLUDED_LABELS) as Array<keyof BulkPreview['excluded']>)
    .filter((k) => excluded[k] > 0).map((k) => `${excluded[k]} ${EXCLUDED_LABELS[k]}`).join(', ');
}

interface Props { open: boolean; bankAccountId: string | null; onClose: () => void; onChanged: () => void }

export function BulkAcceptModal({ open, bankAccountId, onClose, onChanged }: Props) {
  const { state, load, confirm, undo, reset } = useBulkAccept(bankAccountId);
  const { phase, preview, confirmed, undone, posted, error, changed } = state;
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) void load(); else reset(); }, [open, load, reset]);
  const close = () => { if (changed) onChanged(); onClose(); };
  if (!open) return null;
  const lines = preview?.lines ?? [];
  const busy = phase === 'loading' || phase === 'confirming' || phase === 'undoing';
  const refused = confirmed?.refused ?? [];

  return (
    <Modal open onClose={close} size="xl" initialFocusRef={confirmRef}
      title={phase === 'result' || phase === 'undoing' ? 'High-confidence suggestions: result' : `Accept ${lines.length} high-confidence suggestion${lines.length === 1 ? '' : 's'}`}>
      <Modal.Body>
        <div role="status" aria-live="polite" className="sr-only">{busy ? 'Working' : ''}</div>
        {error && <p role="alert" className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
        {phase === 'loading' && <p className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">Loading suggestions…</p>}
        {(phase === 'preview' || phase === 'confirming') && preview && <PreviewBody preview={preview} onNextPage={() => void load(preview.nextScanAfter)} busy={busy} />}
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
                    <span className="font-medium">{posted.get(r.txId) ?? r.txId}</span>: {r.reason}
                  </li>
                ))}
              </ul>
            )}
            {undone && <p role="status" className="mt-3 text-sm text-emerald-300">{undone.undone ? `Batch undone: ${undone.reversed} line${undone.reversed === 1 ? '' : 's'} reversed.` : partialUndoMessage(undone)}</p>}
            {confirmed.runId && !undone && <p className="mt-3 text-xs text-[var(--ff-text-tertiary)]">Undo reverses exactly this batch. It stays available later under Auto-post runs.</p>}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        {(phase === 'preview' || phase === 'confirming' || phase === 'loading') && (
          <>
            <button type="button" onClick={close} className="rounded px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
            <button type="button" ref={confirmRef} onClick={() => void confirm()} disabled={busy || lines.length === 0 || !preview?.previewToken}
              aria-busy={phase === 'confirming' || undefined} className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {phase === 'confirming' ? 'Posting…' : `Confirm and post ${lines.length}`}
            </button>
          </>
        )}
        {(phase === 'result' || phase === 'undoing') && (
          <>
            {confirmed?.runId && !undone && (
              <button type="button" onClick={() => void undo()} disabled={busy} aria-busy={phase === 'undoing' || undefined}
                className="rounded border border-red-500/50 px-4 py-2 text-sm text-red-300 disabled:opacity-50">
                {phase === 'undoing' ? 'Undoing…' : 'Undo batch'}
              </button>
            )}
            <button type="button" ref={confirmRef} onClick={close} className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white">Done</button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}

function PreviewBody({ preview, onNextPage, busy }: { preview: BulkPreview; onNextPage: () => void; busy: boolean }) {
  const { lines } = preview;
  const left = excludedSummary(preview.excluded);
  return (
    <div>
      {lines.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--ff-text-secondary)]">No high-confidence suggestions can be posted right now.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="bulk-totals">
            <span>Total in <b>{formatMoney(preview.totalIn)}</b></span>
            <span>Total out <b>{formatMoney(preview.totalOut)}</b></span>
          </div>
          <ul aria-label="By account" className="mb-3 space-y-0.5 text-xs text-[var(--ff-text-secondary)]">
            {preview.byAccount.map((a) => (
              <li key={a.glAccountId}>{[a.code, a.name].filter(Boolean).join(' ')}: {a.count} line{a.count === 1 ? '' : 's'}
                {a.totalIn > 0 && `, in ${formatMoney(a.totalIn)}`}{a.totalOut > 0 && `, out ${formatMoney(a.totalOut)}`}</li>
            ))}
          </ul>
          <div className="max-h-72 overflow-auto rounded border border-[var(--ff-border-light)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--ff-bg-secondary)] text-left text-[var(--ff-text-tertiary)]">
                <tr><th className="px-2 py-1">Date</th><th className="px-2 py-1">Description</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1">Account</th><th className="px-2 py-1">VAT</th><th className="px-2 py-1 text-right">Confidence</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-[var(--ff-border-light)]">
                    <td className="px-2 py-1 whitespace-nowrap">{l.date}</td>
                    <td className="px-2 py-1 max-w-[16rem] truncate" title={l.description ?? ''}>{l.description}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{formatMoney(l.amount)}</td>
                    <td className="px-2 py-1">{[l.glAccountCode, l.glAccountName].filter(Boolean).join(' ')}</td>
                    <td className="px-2 py-1">{l.effectiveVatCode}</td>
                    <td className="px-2 py-1 text-right">{Math.round(l.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="mt-3 space-y-1 text-xs text-[var(--ff-text-secondary)]">
        {preview.truncated && <p>Showing the first {lines.length}. A confirm posts at most {lines.length}; preview again for the rest.</p>}
        {left && <p>Left out (a confirm would refuse them): {left}.</p>}
        {preview.needsAttentionCount > 0 && <p>{preview.needsAttentionCount}{preview.scanTruncated ? '+' : ''} need a colleague or an approval and are not included.</p>}
        {preview.scanTruncated && preview.nextScanAfter && (
          <p>The scan stopped early.{' '}
            <button type="button" onClick={onNextPage} disabled={busy} className="underline">Look further for more</button>
          </p>
        )}
      </div>
    </div>
  );
}
