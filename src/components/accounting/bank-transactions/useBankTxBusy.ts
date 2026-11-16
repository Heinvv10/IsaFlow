/**
 * useBankTxBusy - the in-flight guard of the page's mutating buttons (WP3). `run(key, fn)` refuses a second call with
 * the same key while the first is still running (a ref, so two clicks in one tick cannot both pass), and `busy` is the
 * set of keys running, for the button's disabled state and label. `progress` carries "3 of 12" for a batch.
 * Operations may also name the ROWS they touch: while one runs, a different operation on any of those rows is refused too
 * (Batch Allocate vs a row Accept or Mark Reviewed on the same line would post it twice), and each touched row shows as
 * `row:<id>` in `busy` so its buttons can disable.
 */

import { useCallback, useRef, useState } from 'react';
import { notify } from '@/utils/toast';

export interface BankTxBusy {
  busy: ReadonlySet<string>;
  isBusy: (key: string) => boolean;
  /** Runs `fn` unless `key` is running, or another operation holds one of `rows`; resolves to undefined when refused. */
  run: <T>(key: string, fn: () => Promise<T>, rows?: readonly string[]) => Promise<T | undefined>;
  progress: { key: string; done: number; total: number } | null;
  setProgress: (p: { key: string; done: number; total: number } | null) => void;
}

export function useBankTxBusy(): BankTxBusy {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<BankTxBusy['progress']>(null);
  const running = useRef(new Map<string, readonly string[]>());
  const snapshot = () => {
    const keys = new Set<string>();
    running.current.forEach((rows, key) => { keys.add(key); rows.forEach(r => keys.add(`row:${r}`)); });
    return keys;
  };
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, rows: readonly string[] = []): Promise<T | undefined> => {
    if (running.current.has(key)) return undefined;
    const held = new Set<string>();
    running.current.forEach(r => r.forEach(id => held.add(id)));
    if (rows.some(id => held.has(id))) { notify.warning('Those lines are already being processed', 'Wait for it to finish, then try again.'); return undefined; }
    running.current.set(key, rows); setBusy(snapshot());
    try { return await fn(); }
    finally { running.current.delete(key); setBusy(snapshot()); }
  }, []);
  const isBusy = useCallback((key: string) => busy.has(key), [busy]);
  return { busy, isBusy, run, progress, setProgress };
}
