import { useCallback, useEffect, useRef } from 'react';

/**
 * A one-shot timer owned by the component: scheduling again replaces the pending one, and unmounting cancels it.
 * For auto-dismissed toasts, so the callback never fires into an unmounted page (or a torn-down test environment).
 */
export function useTimeoutOnce(): (fn: () => void, ms: number) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);
}
