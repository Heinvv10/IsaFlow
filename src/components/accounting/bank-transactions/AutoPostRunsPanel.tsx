/**
 * AutoPostRunsPanel — shows recent confidence auto-post runs and allows bulk undo.
 * Hides itself when there are no active (not yet undone) runs with posted transactions.
 */

import { useState, useEffect, useCallback } from 'react';
import { ApiEnvelopeError, apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { HandOffsetNotice, type HandOffset } from './HandOffsetNotice';
import { formatMoney } from '@/lib/money/formatMoney';

interface AutoPostRun {
  id: string;
  source: string;
  postedCount: number;
  totalAmount: number;
  createdAt: string;
  undoneAt: string | null;
}

interface AutoPostRunsResponse {
  data: {
    runs: AutoPostRun[];
  };
}

/** `undoRun`'s result. `undone` is false whenever a line was skipped. */
interface UndoResult {
  reversed: number;
  skippedBy: { reconciled: number; contended: number; failed: number; offsetByHand: number };
  undone: boolean;
  handOffsets: HandOffset[];
}

/**
 * What the user needs to know about a partial undo: the run stays listed, and
 * each skip reason has its own remedy — pressing Undo again changes nothing
 * for a reconciled or failed line until it is dealt with.
 */
function partialUndoMessage({ reversed, skippedBy }: UndoResult): string {
  const reasons = [
    // No reopen exists yet (R-111), so do not send the user to one.
    skippedBy.reconciled > 0
      ? `${skippedBy.reconciled} on a reconciliation — remove them from an open session first; a completed one must be reopened first (newest first)`
      : null,
    skippedBy.contended > 0 ? `${skippedBy.contended} in use by another request — try again in a moment` : null,
    skippedBy.failed > 0
      ? `${skippedBy.failed} could not be reversed (for example, a closed period) — check those lines`
      : null,
    skippedBy.offsetByHand > 0
      ? `${skippedBy.offsetByHand} may already be corrected by a later journal — see below`
      : null,
  ].filter((r): r is string => r !== null);
  return `Reversed ${reversed} line${reversed === 1 ? '' : 's'}. Not undone: ${reasons.join('; ')}.`;
}

export function AutoPostRunsPanel({ onUndone }: { onUndone?: () => void }) {
  const [runs, setRuns] = useState<AutoPostRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [handOffsets, setHandOffsets] = useState<{ runId: string; offsets: HandOffset[] } | null>(null);

  const load = useCallback(() => {
    setLoadError('');
    apiFetch('/api/accounting/bank-auto-post', { credentials: 'include' })
      .then(async (r) => { await assertOk(r, 'Could not load recent auto-post runs - try again'); return r.json(); })
      .then((j: AutoPostRunsResponse) => setRuns(j?.data?.runs ?? []))
      .catch((err) => { setRuns([]); setLoadError(apiErrorMessage(err, 'Could not load recent auto-post runs - try again')); });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function undo(runId: string) {
    setBusy(runId);
    setUndoError(null);
    setUndoNotice(null);
    setHandOffsets(null);
    try {
      const res = await apiFetch('/api/accounting/bank-auto-post', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', runId }),
      });
      if (res.status === 409) {
        throw new ApiEnvelopeError('Another request is working on this run\'s lines — try again in a moment.');
      }
      await assertOk(res, 'Could not undo this run - try again');
      const result = ((await res.json()) as { data?: UndoResult }).data;
      if (result?.undone === false) setUndoNotice(partialUndoMessage(result));
      if (result?.handOffsets?.length) setHandOffsets({ runId, offsets: result.handOffsets });
      load();
      onUndone?.();
    } catch (err) {
      setUndoError(apiErrorMessage(err, 'Could not undo this run - try again'));
    } finally {
      setBusy(null);
    }
  }

  function decided(offset: HandOffset, runClosed: boolean, next: HandOffset | null) {
    setHandOffsets((prev) => {
      const rest = prev?.offsets.filter((o) => o.transactionId !== offset.transactionId) ?? [];
      const offsets = next ? [...rest, next] : rest;
      return prev && offsets.length > 0 ? { runId: prev.runId, offsets } : null;
    });
    if (runClosed) setUndoNotice(null);
    load();
    onUndone?.();
  }

  const active = runs.filter((r) => !r.undoneAt && r.postedCount > 0);
  if (active.length === 0 && !loadError) return null;

  return (
    <div className="mb-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3">
      <h3 className="text-xs font-semibold text-[var(--ff-text-secondary)] mb-2">Recent auto-post runs</h3>
      {loadError && (
        <p role="alert" className="text-xs text-red-400 mb-2">{loadError}</p>
      )}
      {undoError && (
        <p className="text-xs text-red-400 mb-2">{undoError}</p>
      )}
      {undoNotice && (
        <p role="status" className="text-xs text-amber-500 mb-2">{undoNotice}</p>
      )}
      {handOffsets && (
        <ul aria-label="Lines already corrected by hand" className="space-y-1 mb-2">
          {handOffsets.offsets.map((o) => (
            <HandOffsetNotice key={o.transactionId} runId={handOffsets.runId} offset={o} onDecided={decided} />
          ))}
        </ul>
      )}
      <ul className="space-y-1">
        {active.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between text-sm text-[var(--ff-text-primary)]"
          >
            <span>
              Auto-posted {r.postedCount} ({formatMoney(r.totalAmount)}) · {r.source}
            </span>
            <button
              type="button"
              disabled={busy === r.id}
              onClick={() => { void undo(r.id); }}
              className="text-xs text-blue-500 hover:underline disabled:opacity-50"
            >
              {busy === r.id ? 'Undoing…' : 'Undo'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
