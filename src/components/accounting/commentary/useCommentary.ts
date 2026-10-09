/**
 * Fetches, generates, approves and rejects commentary for one report pack
 * against the Task 10 routes.
 *
 * `rows` is the FULL, unfiltered set for the pack — `CommentaryBlock` already
 * knows how to pick out one section's rows for each of its two render modes,
 * and duplicating that filter here would just be a second copy that can drift
 * from the first.
 *
 * There is therefore no `sectionRef` parameter. The list route takes type,
 * from and to and nothing else, so a section-shaped argument here could only
 * ever have been decoration — it was, and it was ignored. `CommentaryPanel`
 * still takes one, because `CommentaryBlock` needs it to render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

export interface UseCommentaryInput {
  params: SharePackParams;
}

export interface UseCommentaryResult {
  rows: CommentaryRow[];
  loading: boolean;
  error: string | null;
  generate: (replace?: boolean) => Promise<void>;
  /** `text` present = approve with the approver's own wording. Resolves true
   *  only when the server accepted the approval. */
  approve: (id: string, text?: string) => Promise<boolean>;
  reject: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useCommentary({ params }: UseCommentaryInput): UseCommentaryResult {
  const [rows, setRows] = useState<CommentaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { type, from, to } = params;

  // A later `refresh()` (a params change, or approve/reject/generate calling
  // it again) can resolve before an earlier one that is still in flight. Each
  // call claims the next sequence number; a response only reaches `setRows`/
  // `setError` if its number is still the latest one issued — otherwise it is
  // a stale response for params (or a moment) this hook has already moved
  // past, and applying it would overwrite the current, correct state with an
  // older one. Bumped past on unmount too, so a response that resolves after
  // the component is gone updates nothing.
  const requestId = useRef(0);
  // The params key the current `rows` were loaded for. A failed refresh for a
  // DIFFERENT key must not leave the old pack's sentences (with Approve/Reject)
  // on screen under the new pack.
  const loadedKey = useRef<string | null>(null);
  useEffect(() => () => { requestId.current += 1; }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ type, from, to });
      const r = await apiJson(`/api/accounting/commentary?${qs.toString()}`, undefined, 'Could not load the commentary - try again');
      if (requestId.current !== id) return;
      // NOT `: []`. The route's type is a union of the GET and POST envelopes,
      // and an empty array for the wrong arm renders as "no commentary yet" —
      // so a broken response invites somebody to regenerate over sentences a
      // named person already approved.
      if (!('commentary' in r)) throw new ApiEnvelopeError('The commentary response did not contain any commentary rows.');
      setRows(r.commentary);
      loadedKey.current = `${type}|${from}|${to}`;
    } catch (err) {
      if (requestId.current !== id) return;
      if (loadedKey.current !== `${type}|${from}|${to}`) setRows([]);
      setError(apiErrorMessage(err, 'Could not load the commentary - try again'));
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [type, from, to]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // generate/approve/reject never mutate `rows` on failure — a rejected request
  // leaves the last successfully-loaded state exactly as it was. Only
  // `refresh()` replaces it, and clears it when it fails for changed params.
  const generate = useCallback(async (replace = false) => {
    setError(null);
    try {
      await apiJson('/api/accounting/commentary', {
        method: 'POST',
        body: JSON.stringify({ params: { type, from, to }, replace }),
      }, 'Could not generate the commentary - try again');
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not generate the commentary - try again'));
    }
  }, [type, from, to, refresh]);

  const approve = useCallback(async (id: string, text?: string) => {
    setError(null);
    try {
      await apiJson(`/api/accounting/commentary/${id}/approve`, {
        method: 'POST',
        ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
      }, 'Could not approve the commentary - try again');
      await refresh();
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not approve the commentary - try again'));
      return false;
    }
  }, [refresh]);

  const reject = useCallback(async (id: string) => {
    setError(null);
    try {
      await apiJson(`/api/accounting/commentary/${id}/reject`, { method: 'POST' }, 'Could not reject the commentary - try again');
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not reject the commentary - try again'));
    }
  }, [refresh]);

  return { rows, loading, error, generate, approve, reject, refresh };
}
