/**
 * useBankTxBusy - the in-flight guard of the page's mutating buttons (WP3). `run(key, fn)` refuses a second call with
 * the same key while the first is still running (a ref, so two clicks in one tick cannot both pass), and `busy` is the
 * set of keys running, for the button's disabled state and label. `progress` carries "3 of 12" for a batch.
 */

import { useCallback, useRef, useState } from 'react';

export interface BankTxBusy {
  busy: ReadonlySet<string>;
  isBusy: (key: string) => boolean;
  /** Runs `fn` unless `key` is already running; resolves to undefined when it was refused. */
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T | undefined>;
  progress: { key: string; done: number; total: number } | null;
  setProgress: (p: { key: string; done: number; total: number } | null) => void;
}

export function useBankTxBusy(): BankTxBusy {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<BankTxBusy['progress']>(null);
  const running = useRef(new Set<string>());
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current.has(key)) return undefined;
    running.current.add(key); setBusy(new Set(running.current));
    try { return await fn(); }
    finally { running.current.delete(key); setBusy(new Set(running.current)); }
  }, []);
  const isBusy = useCallback((key: string) => busy.has(key), [busy]);
  return { busy, isBusy, run, progress, setProgress };
}
