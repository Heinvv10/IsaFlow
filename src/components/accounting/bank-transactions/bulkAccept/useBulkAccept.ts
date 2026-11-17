/**
 * The bulk-accept modal's state: load a preview page, confirm it, undo exactly that batch. One request at a time; the
 * latest one wins (a slower older answer never overwrites a newer screen). A failure keeps the screen it came from.
 */
import { useCallback, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { confirmBulk, fetchBulkPreview, undoBulk, type BulkConfirmed, type BulkPreview, type BulkUndone } from './bulkAcceptApi';

export type BulkPhase = 'idle' | 'loading' | 'preview' | 'confirming' | 'result' | 'undoing';

export interface BulkAcceptState {
  phase: BulkPhase;
  preview: BulkPreview | null;
  confirmed: BulkConfirmed | null;
  undone: BulkUndone | null;
  /** The previewed lines, kept so the result can name the lines it refused. */
  posted: Map<string, string>;
  error: string;
  /** Anything was written: the page must reload when the modal closes. */
  changed: boolean;
}

const START: BulkAcceptState = { phase: 'idle', preview: null, confirmed: null, undone: null, posted: new Map(), error: '', changed: false };

export function useBulkAccept(bankAccountId: string | null) {
  const [state, setState] = useState<BulkAcceptState>(START);
  const seq = useRef(0);
  const patch = (p: Partial<BulkAcceptState>) => setState((s) => ({ ...s, ...p }));

  const load = useCallback(async (scanAfter?: string | null) => {
    if (!bankAccountId) return;
    const mine = ++seq.current;
    setState((s) => ({ ...START, changed: s.changed, phase: 'loading' }));
    try {
      const preview = await fetchBulkPreview(bankAccountId, scanAfter);
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'preview', preview, error: '' }));
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'preview', preview: s.preview, error: apiErrorMessage(err, 'Could not load the high-confidence suggestions - try again') }));
    }
  }, [bankAccountId]);

  const confirm = useCallback(async () => {
    const preview = state.preview;
    if (!preview?.previewToken || state.phase !== 'preview') return;
    const mine = ++seq.current;
    const names = new Map(preview.lines.map((l) => [l.id, l.description ?? l.id]));
    patch({ phase: 'confirming', error: '' });
    try {
      const confirmed = await confirmBulk(preview.previewToken);
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'result', confirmed, posted: names, changed: s.changed || confirmed.posted.length > 0 }));
    } catch (err) {
      // The post may or may not have happened (a dropped answer): the page reloads either way when this closes.
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'preview', changed: true, error: apiErrorMessage(err, 'Could not post the suggestions - check the list before trying again') }));
    }
  }, [state.preview, state.phase]);

  const undo = useCallback(async () => {
    const runId = state.confirmed?.runId;
    if (!runId || state.phase !== 'result' || state.undone) return;
    const mine = ++seq.current;
    patch({ phase: 'undoing', error: '' });
    try {
      const undone = await undoBulk(runId);
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'result', undone, changed: true }));
    } catch (err) {
      if (mine === seq.current) setState((s) => ({ ...s, phase: 'result', error: apiErrorMessage(err, 'Could not undo this batch - try again') }));
    }
  }, [state.confirmed, state.phase, state.undone]);

  const reset = useCallback(() => { seq.current += 1; setState(START); }, []);
  return { state, load, confirm, undo, reset };
}
