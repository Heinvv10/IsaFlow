/**
 * The bulk-accept modal's state: load a preview page, confirm it, undo exactly that batch. One request at a time; the
 * latest one wins (a slower older answer never overwrites a newer screen). A failure keeps the screen it came from.
 */
import { useCallback, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import type { HandOffset } from '../HandOffsetNotice';
import { confirmBulk, fetchBulkPreview, findRecentBatch, isDefinitiveFailure, undoBulk, type BulkConfirmed, type BulkPreview, type BulkUndone } from './bulkAcceptApi';

export type BulkPhase = 'idle' | 'loading' | 'preview' | 'confirming' | 'result' | 'undoing';

export interface BulkAcceptState {
  phase: BulkPhase;
  preview: BulkPreview | null;
  /** Another page is being read while `preview` stays on screen. */
  refreshing: boolean;
  confirmed: BulkConfirmed | null;
  undone: BulkUndone | null;
  /** Lines of the previewed page by id, so the result can name the lines it refused. */
  names: Map<string, string>;
  error: string;
  /** The answer to a confirm was lost, but a batch it started was found: Undo works on it. */
  recovered: { postedCount: number } | null;
  /** A confirm failed: its token is dead (the lines moved, or another batch held the account) and a fresh preview is needed. */
  tokenDead: boolean;
  /** Anything may have been written: the page must reload when the modal closes. */
  changed: boolean;
}

const START: BulkAcceptState = {
  phase: 'idle', preview: null, refreshing: false, confirmed: null, undone: null, names: new Map(), error: '', recovered: null, tokenDead: false, changed: false,
};

export function useBulkAccept(bankAccountId: string | null) {
  const [state, setState] = useState<BulkAcceptState>(START);
  const seq = useRef(0);
  // A ref, not state: two clicks batched into one render both see the same state, and must still send one request.
  const inFlight = useRef(false);
  const patch = (p: Partial<BulkAcceptState>) => setState((s) => ({ ...s, ...p }));

  /** The first page, or - `keepPage` - another page read while the one on screen stays (and can still be confirmed). */
  const load = useCallback(async (scanAfter?: string | null, keepPage = false) => {
    if (!bankAccountId) return;
    const mine = ++seq.current;
    if (keepPage) setState((s) => ({ ...s, refreshing: true, error: '' }));
    else setState((s) => ({ ...START, changed: s.changed, phase: 'loading' }));
    try {
      const preview = await fetchBulkPreview(bankAccountId, scanAfter);
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'preview', preview, refreshing: false, error: '', tokenDead: false }));
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'preview', refreshing: false, error: apiErrorMessage(err, 'Could not load the high-confidence suggestions - try again') }));
    }
  }, [bankAccountId]);

  const confirm = useCallback(async () => {
    const preview = state.preview;
    if (!preview?.previewToken || state.phase !== 'preview' || state.tokenDead || state.refreshing || inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    const startedAt = Date.now();
    const names = new Map(preview.lines.map((l) => [l.id, l.description ?? l.id]));
    patch({ phase: 'confirming', error: '' });
    try {
      const confirmed = await confirmBulk(preview.previewToken);
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'result', confirmed, names, changed: s.changed || confirmed.posted.length > 0 }));
    } catch (err) {
      if (mine !== seq.current) return;
      const message = apiErrorMessage(err, 'Could not post the suggestions - reload the preview before trying again');
      // The server answered: nothing is half-done, and the token is spent. Otherwise (a dropped answer) the batch may have
      // posted: look for it so Undo stays possible, and never leave the old token to be confirmed again.
      let found: Awaited<ReturnType<typeof findRecentBatch>> = null;
      if (!isDefinitiveFailure(err)) found = await findRecentBatch(startedAt).catch(() => null);
      if (mine !== seq.current) return;
      if (found) {
        const confirmed: BulkConfirmed = { runId: found.id, posted: [], refused: [], totalPosted: found.totalAmount };
        setState((s) => ({ ...s, phase: 'result', confirmed, names, recovered: { postedCount: found!.postedCount }, changed: true }));
      } else {
        setState((s) => ({ ...s, phase: 'preview', changed: true, tokenDead: true, error: message }));
      }
    } finally { inFlight.current = false; }
  }, [state.preview, state.phase, state.tokenDead, state.refreshing]);

  const undo = useCallback(async () => {
    const runId = state.confirmed?.runId;
    if (!runId || state.phase !== 'result' || state.undone?.undone || inFlight.current) return;
    inFlight.current = true;
    const mine = ++seq.current;
    patch({ phase: 'undoing', error: '' });
    try {
      const undone = await undoBulk(runId);
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'result', undone, changed: true }));
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'result', error: apiErrorMessage(err, 'Could not undo this batch - try again') }));
    } finally { inFlight.current = false; }
  }, [state.confirmed, state.phase, state.undone]);

  /** A hand-offset decision (R-079) was recorded: the run is closed, or the next blocking journal replaces this one. */
  const handOffDecided = useCallback((offset: HandOffset, runClosed: boolean, next: HandOffset | null) => {
    setState((s) => {
      if (!s.undone) return s;
      const rest = s.undone.handOffsets.filter((o) => o.transactionId !== offset.transactionId);
      return { ...s, undone: { ...s.undone, handOffsets: next ? [...rest, next] : rest, undone: runClosed ? true : s.undone.undone } };
    });
  }, []);

  const reset = useCallback(() => { seq.current += 1; setState(START); }, []);
  return { state, load, confirm, undo, reset, handOffDecided };
}
