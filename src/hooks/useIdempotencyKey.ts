import { useCallback, useRef } from 'react';

/**
 * The `Idempotency-Key` for a form that posts a journal (audit 2026-11-15, bank WP2 row 7). One key per request body:
 * a retry or a double-click of the SAME body reuses it, so the server answers the first result and posts nothing
 * twice; an edited body is a new request and gets a new key. Call `done()` once the post succeeded so the next
 * transaction starts fresh.
 */
export function useIdempotencyKey() {
  const current = useRef<{ body: string; key: string } | null>(null);
  const keyFor = useCallback((body: string): string => {
    if (current.current?.body !== body) current.current = { body, key: crypto.randomUUID() };
    return current.current.key;
  }, []);
  const done = useCallback(() => { current.current = null; }, []);
  return { keyFor, done };
}
