/**
 * useRemoteOptions - the load / debounce / cancel / error plumbing behind every picker.
 *
 * Loads lazily: nothing is requested until the dropdown opens, and every open refetches (so a record created
 * since the last open appears, and a failed load is retried). Typing is debounced; a newer request cancels the
 * older one, and a response for a superseded request is dropped. A failure sets `error` and EMPTIES `options`,
 * so the dropdown shows the failure instead of an empty list that reads as "no results".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { SelectOption } from '../Select';

export interface FetchContext {
  /** True for the load that an open triggers (empty query); false for a refinement typed afterwards. */
  initial: boolean;
}

export type FetchOptions = (query: string, signal: AbortSignal, ctx: FetchContext) => Promise<SelectOption[]>;

export interface RemoteOptions {
  options: SelectOption[];
  loading: boolean;
  error: string | null;
  onSearch: (query: string) => void;
  onOpenChange: (open: boolean) => void;
}

export const DEFAULT_DEBOUNCE_MS = 250;

export function useRemoteOptions(fetchOptions: FetchOptions, failureMessage: string, debounceMs = DEFAULT_DEBOUNCE_MS): RemoteOptions {
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
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
    try {
      const next = await fetchRef.current(query, ctl.signal, { initial });
      if (seq.current !== mine) return;
      setOptions(next);
      setError(null);
    } catch (err) {
      if (seq.current !== mine) return;
      log.warn('Picker options failed to load', { error: err instanceof Error ? err.message : String(err) }, 'ui-picker');
      setOptions([]);
      setError(apiErrorMessage(err, messageRef.current));
    } finally {
      if (seq.current === mine) setLoading(false);
    }
  }, [cancel]);

  const onSearch = useCallback((query: string) => {
    cancel();
    setLoading(true);
    timer.current = setTimeout(() => { void run(query, false); }, debounceMs);
  }, [cancel, run, debounceMs]);

  const onOpenChange = useCallback((open: boolean) => {
    if (open) void run('', true);
    else { cancel(); setLoading(false); }
  }, [run, cancel]);

  useEffect(() => cancel, [cancel]);

  return { options, loading, error, onSearch, onOpenChange };
}
