/**
 * useRemoteOptions - the load / debounce / cancel / error plumbing behind every remote picker.
 *
 * Loads lazily: nothing is requested until the dropdown opens, and every open refetches (so a record created
 * since the last open appears, and a failed load is retried). Typing is debounced; a newer request cancels the
 * older one, and a response for a superseded request is dropped. A failure sets `error`, which the dropdown shows
 * INSTEAD of the list (an empty list would read as "no results"); the next request clears it.
 *
 * `loading` is true from the start and again whenever the dropdown is closed: the render in which it opens must
 * already say "Loading", not flash "No matches" until the open effect has started the request.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { SelectOption } from '../Select';

export interface FetchContext {
  /** True for the load that an open triggers (empty query); false for a refinement typed afterwards. */
  initial: boolean;
}

export interface FetchResult {
  options: SelectOption[];
  /** Shown under the list, e.g. when the server returned a truncated page. */
  hint?: string;
}

export type FetchOptions = (query: string, signal: AbortSignal, ctx: FetchContext) => Promise<FetchResult>;

export interface RemoteOptions {
  options: SelectOption[];
  hint: string | undefined;
  loading: boolean;
  error: string | null;
  onSearch: (query: string) => void;
  onOpenChange: (open: boolean) => void;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function useRemoteOptions(fetchOptions: FetchOptions, failureMessage: string, debounceMs = DEFAULT_DEBOUNCE_MS): RemoteOptions {
  const [result, setResult] = useState<FetchResult>({ options: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRef = useRef(fetchOptions);
  const messageRef = useRef(failureMessage);
  useEffect(() => { fetchRef.current = fetchOptions; messageRef.current = failureMessage; });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const seq = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    controller.current?.abort();
    controller.current = null;
    seq.current += 1;
  }, []);

  const run = useCallback(async (query: string, initial: boolean) => {
    cancel();
    const mine = seq.current;
    const ctl = new AbortController();
    controller.current = ctl;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchRef.current(query, ctl.signal, { initial });
      if (seq.current !== mine) return;
      setResult(next);
    } catch (err) {
      if (seq.current !== mine) return;
      log.warn('Picker options failed to load', { error: err instanceof Error ? err.message : String(err) }, 'ui-picker');
      setError(apiErrorMessage(err, messageRef.current));
    } finally {
      if (seq.current === mine) setLoading(false);
    }
  }, [cancel]);

  const onSearch = useCallback((query: string) => {
    cancel();
    setLoading(true);
    setError(null);
    timer.current = setTimeout(() => { void run(query, false); }, debounceMs);
  }, [cancel, run, debounceMs]);

  const onOpenChange = useCallback((open: boolean) => {
    if (open) void run('', true);
    else { cancel(); setLoading(true); }
  }, [run, cancel]);

  useEffect(() => cancel, [cancel]);

  return { options: result.options, hint: result.hint, loading, error, onSearch, onOpenChange };
}
