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

/**
 * The longest one operation may hold its key and rows. apiFetch has no timeout, so a request that never answers would hold
 * its lines for good: after this the hold is released and the user is told. The request itself is not cancelled - it may
 * still finish; its late completion changes nothing (the hold is no longer its own).
 */
export const BUSY_HOLD_CAP_MS = 60_000;

export interface BankTxBusy {
  busy: ReadonlySet<string>;
  isBusy: (key: string) => boolean;
  /** Whether `key` is running RIGHT NOW (a ref: true for a caller in the same tick, which `busy` is not). */
  isRunning: (key: string) => boolean;
  /** Runs `fn` unless `key` is running, or another operation holds one of `rows`; resolves to undefined when refused. */
  run: <T>(key: string, fn: () => Promise<T>, rows?: readonly string[]) => Promise<T | undefined>;
  progress: { key: string; done: number; total: number } | null;
  setProgress: (p: { key: string; done: number; total: number } | null) => void;
}

export function useBankTxBusy(): BankTxBusy {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<BankTxBusy['progress']>(null);
  const running = useRef(new Map<string, { rows: readonly string[]; token: symbol }>());
  const snapshot = () => {
    const keys = new Set<string>();
    running.current.forEach(({ rows }, key) => { keys.add(key); rows.forEach(r => keys.add(`row:${r}`)); });
    return keys;
  };
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, rows: readonly string[] = []): Promise<T | undefined> => {
    if (running.current.has(key)) return undefined;
    const held = new Set<string>();
    running.current.forEach(h => h.rows.forEach(id => held.add(id)));
    if (rows.some(id => held.has(id))) { notify.warning('Those lines are already being processed', 'Wait for it to finish, then try again.'); return undefined; }
    const token = Symbol(key);
    const release = () => { if (running.current.get(key)?.token === token) { running.current.delete(key); setBusy(snapshot()); } };
    running.current.set(key, { rows, token }); setBusy(snapshot());
    const cap = setTimeout(() => {
      if (running.current.get(key)?.token !== token) return;
      release(); setProgress(null);
      notify.warning('This is taking too long', 'You can try again. If it did go through, refresh the list to see it.');
    }, BUSY_HOLD_CAP_MS);
    try { return await fn(); }
    finally { clearTimeout(cap); release(); }
  }, []);
  const isRunning = useCallback((key: string) => running.current.has(key), []);
  const isBusy = useCallback((key: string) => busy.has(key), [busy]);
  return { busy, isBusy, isRunning, run, progress, setProgress };
}

/** The three bulk operations act on the same selected lines: while any runs, all three (and the review bar) wait. */
export const isBulkBusy = (busy: ReadonlySet<string> | undefined): boolean =>
  !!busy && (busy.has('review') || busy.has('batch-allocate') || busy.has('delete'));
