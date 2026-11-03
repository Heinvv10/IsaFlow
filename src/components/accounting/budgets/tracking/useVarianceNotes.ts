/**
 * The variance notes of one (version, month) on the Budget vs Actual page (budgets P5 spec §3e, §5), and
 * the save / approve / reject actions against `/api/accounting/budgets/variance-notes`. `scope` null (a
 * window of more than one month, or no version) loads nothing and clears what was shown.
 *
 * A response for a scope the page has moved past is dropped (request counter). An action never edits
 * `notes` itself: on success it reloads, on failure it leaves the last loaded state and returns the reason.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import type { VarianceNote, VarianceSlice } from '@/modules/accounting/services/commentary/varianceNoteTypes';

export interface VarianceNotesScope { versionId: string; month: string }

/** null on success, else the reason to show. */
export type ActionResult = string | null;

export interface UseVarianceNotes {
  /** By `row_ref` (`varianceRowRef`). */
  notes: ReadonlyMap<string, VarianceNote>;
  error: string | null;
  /** The notes on hand are this scope's and loaded without error: the only state a write may be offered in. */
  ready: boolean;
  save: (slice: VarianceSlice, text: string) => Promise<ActionResult>;
  /** `seenDraft`: the draft text on screen; a note changed since is refused (409) and the notes reload.
   *  `editedText`: the approver's own wording (approve-with-edit). */
  approve: (id: string, seenDraft: string, editedText?: string) => Promise<ActionResult>;
  /** As `approve`: the draft on screen is compared; a refusal reloads the notes. */
  reject: (id: string, seenDraft: string) => Promise<ActionResult>;
}

export function useVarianceNotes(scope: VarianceNotesScope | null): UseVarianceNotes {
  const [notes, setNotes] = useState<ReadonlyMap<string, VarianceNote>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const seq = useRef(0);
  const versionId = scope?.versionId ?? null;
  const month = scope?.month ?? null;
  const key = versionId === null || month === null ? null : `${versionId}|${month}`;
  useEffect(() => () => { seq.current += 1; }, []);

  // Another scope's notes are never shown under this one, nor written against while it loads.
  useEffect(() => {
    setNotes(new Map());
    setLoadedKey(null);
    setError(null);
  }, [key]);

  const load = useCallback(async () => {
    const id = ++seq.current;
    if (versionId === null || month === null) return;
    try {
      const r = await apiJson(`/api/accounting/budgets/variance-notes?${new URLSearchParams({ versionId, month }).toString()}`, undefined,
        'Could not load the variance notes - try again');
      if (seq.current !== id) return;
      if (!('notes' in r)) throw new ApiEnvelopeError('The variance notes response did not contain any notes.');
      setNotes(new Map(r.notes.map((n) => [n.rowRef, n])));
      setError(null);
      setLoadedKey(`${versionId}|${month}`);
    } catch (err) {
      if (seq.current !== id) return;
      setNotes(new Map());
      setLoadedKey(null);
      setError(apiErrorMessage(err, 'Could not load the variance notes - try again'));
    }
  }, [versionId, month]);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>, failure: string): Promise<ActionResult> => {
    try {
      await apiJson('/api/accounting/budgets/variance-notes', { method: 'POST', body: JSON.stringify(body) }, failure);
      await load();
      return null;
    } catch (err) {
      return apiErrorMessage(err, failure);
    }
  }, [load]);

  const save = useCallback((slice: VarianceSlice, text: string) => {
    if (versionId === null || month === null) return Promise.resolve('Choose a single month to write a variance note.');
    return post({ action: 'save', versionId, month, ...slice, text }, 'Could not save the note - try again');
  }, [post, versionId, month]);
  const approve = useCallback(async (id: string, seenDraft: string, editedText?: string) => {
    const reason = await post({ action: 'approve', id, draft: seenDraft, ...(editedText === undefined ? {} : { text: editedText }) },
      'Could not approve the note - try again');
    // A refusal (most likely the note changed since it was shown) reloads, so the dialog shows the current text.
    if (reason !== null) await load();
    return reason;
  }, [post, load]);
  const reject = useCallback(async (id: string, seenDraft: string) => {
    const reason = await post({ action: 'reject', id, draft: seenDraft }, 'Could not reject the note - try again');
    if (reason !== null) await load();
    return reason;
  }, [post, load]);

  return { notes, error, ready: key !== null && loadedKey === key && error === null, save, approve, reject };
}
