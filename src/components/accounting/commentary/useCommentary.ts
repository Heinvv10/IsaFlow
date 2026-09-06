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
import { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ type, from, to });
      const r = await apiJson(`/api/accounting/commentary?${qs.toString()}`);
      setRows('commentary' in r ? r.commentary : []);
    } catch (err) {
      setError(errorMessage(err, 'Could not load commentary.'));
    } finally {
      setLoading(false);
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
