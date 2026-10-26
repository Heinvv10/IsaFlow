import { useCallback, useEffect, useRef } from 'react';

/**
 * useTimeoutOnce with one timer per key: scheduling a key again replaces only that key's pending timer, other keys are
 * untouched, and unmounting cancels them all. For per-row badges that each auto-clear on their own clock.
 */
export function useKeyedTimeoutOnce(): (key: string, fn: () => void, ms: number) => void {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);
  return useCallback((key: string, fn: () => void, ms: number) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => { timers.current.delete(key); fn(); }, ms));
  }, []);
}
