/**
 * Loads one page of a drill. The page belongs to the `key` (field + period) it was chosen for, so a change of key is
 * page 1 in the same render and exactly one request goes out; an answer is shown only when it is for the key and page
 * now asked for. `load` may close over anything `key` stands for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, apiErrorMessage } from '@/lib/apiFetch';

export interface DrillFailure { message: string; retryAfterSecs?: number }
interface Answer<T> { key: string; page: number; result?: T; failure?: DrillFailure }

export function useDrillPages<T>(enabled: boolean, key: string, load: (page: number, signal: AbortSignal) => Promise<T>) {
  const [chosen, setChosen] = useState({ key, page: 1 });
  const page = chosen.key === key ? chosen.page : 1;
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loader = useRef(load);
  useEffect(() => { loader.current = load; });
  // Opening forgets the last visit (page and answer) in the same render, so the first paint is a clean page 1. Closing
  // leaves them, so nothing empties while the drawer goes away.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    if (enabled) { setChosen({ key, page: 1 }); setAnswer(null); }
  }

  useEffect(() => {
    if (!enabled) return undefined;
    const ctl = new AbortController();
    const mine = { key, page };
    loader.current(page, ctl.signal)
      .then((result) => { if (!ctl.signal.aborted) setAnswer({ ...mine, result }); })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const retryAfterSecs = e instanceof ApiRequestError ? e.retryAfterSecs : undefined;
        setAnswer({ ...mine, failure: { message: apiErrorMessage(e, 'The lines behind this field could not be loaded.'), retryAfterSecs } });
      });
    return () => ctl.abort();
  }, [enabled, key, page, attempt]);

  const mine = answer && answer.key === key && answer.page === page ? answer : null;
  return {
    page,
    result: mine?.result ?? null,
    failure: mine?.failure ?? null,
    loading: enabled && mine === null,
    /** Some page of this key has been answered: the pager stays (disabled) while the next one loads. */
    paged: answer !== null && answer.key === key,
    setPage: (p: number) => setChosen({ key, page: p }),
    retry: useCallback(() => { setAnswer(null); setAttempt((n) => n + 1); }, []),
  };
}
