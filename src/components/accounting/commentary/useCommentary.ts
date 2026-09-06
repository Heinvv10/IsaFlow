/**
 * Fetches, generates, approves and rejects commentary for one report pack
 * against the Task 10 routes.
 *
 * `rows` is the FULL, unfiltered set for the pack — `CommentaryBlock` already
 * knows how to pick out one section's rows for each of its two render modes,
 * and duplicating that filter here would just be a second copy that can drift
 * from the first. `sectionRef` is accepted anyway, purely to key the effect
 * one instance to one section and to keep this hook's shape matched to
 * `CommentaryPanel`, which needs both to render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, ApiRequestError } from '@/lib/apiFetch';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';
import type { SharePackParams } from '@/modules/accounting/services/share/shareParams';

export interface UseCommentaryInput {
  sectionRef: string;
  params: SharePackParams;
}

export interface UseCommentaryResult {
  rows: CommentaryRow[];
  loading: boolean;
  error: string | null;
  generate: (replace?: boolean) => Promise<void>;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  return fallback;
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
  useEffect(() => () => { requestId.current += 1; }, []);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ type, from, to });
      const r = await apiJson(`/api/accounting/commentary?${qs.toString()}`);
      if (requestId.current !== id) return;
      setRows('commentary' in r ? r.commentary : []);
    } catch (err) {
      if (requestId.current !== id) return;
      setError(errorMessage(err, 'Could not load commentary.'));
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [type, from, to]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Never mutates `rows` on failure — a rejected request leaves the last
  // successfully-loaded state exactly as it was, and `refresh()` is the only
  // path that replaces it.
  const generate = useCallback(async (replace = false) => {
    setError(null);
    try {
      await apiJson('/api/accounting/commentary', {
        method: 'POST',
        body: JSON.stringify({ params: { type, from, to }, replace }),
      });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not generate commentary.'));
    }
  }, [type, from, to, refresh]);

  const approve = useCallback(async (id: string) => {
    setError(null);
    try {
      await apiJson(`/api/accounting/commentary/${id}/approve`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not approve that commentary.'));
    }
  }, [refresh]);

  const reject = useCallback(async (id: string) => {
    setError(null);
    try {
      await apiJson(`/api/accounting/commentary/${id}/reject`, { method: 'POST' });
      await refresh();
    } catch (err) {
      setError(errorMessage(err, 'Could not reject that commentary.'));
    }
  }, [refresh]);

  return { rows, loading, error, generate, approve, reject, refresh };
}
