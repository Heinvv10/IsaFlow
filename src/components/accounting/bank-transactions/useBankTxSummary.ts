/**
 * useBankTxSummary — the bank accounts of the bank-transactions page, each with the figures its card, tiles and
 * statement panel show (GET /api/accounting/bank-account-summaries; WP1 "Truthful numbers", PR-C).
 *
 * `refresh()` carries a sequence guard: only the newest call writes state, so a slow older response (a refresh fired
 * before a mutation) cannot put pre-mutation figures back over the post-mutation ones.
 *
 * "Newest" means the newest to LAND: a response older than one already applied is dropped, but one that lands while
 * nothing newer has landed is applied (a superseding refresh that then fails must not throw away a good answer).
 *
 * Failure is never an empty account list: a failed FIRST load is `status: 'error'` (the page shows the message and
 * Retry, not "No bank accounts configured"); a failed later load keeps the last data and sets `stale`.
 *
 * `refreshSoon()` is for chatty callers (a category saved on every keystroke while coding by keyboard): a trailing
 * debounce, so a burst costs one fetch. `refresh()` (every other write) stays immediate and cancels a pending one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';

export type { BankAccountSummary };

export type SummaryStatus = 'loading' | 'ready' | 'error';

export interface BankTxSummary {
  accounts: BankAccountSummary[];
  status: SummaryStatus;
  /** The first load's failure message (status 'error'). */
  error: string;
  /** A later load failed: `accounts` are the last good figures and may be out of date. */
  stale: boolean;
  refresh: () => Promise<void>;
  /** Trailing-debounced refresh (SOON_MS). */
  refreshSoon: () => void;
}

export const SOON_MS = 400;

const LOAD_FAILED = 'Could not load the bank accounts - try again';

export function useBankTxSummary(): BankTxSummary {
  const [accounts, setAccounts] = useState<BankAccountSummary[]>([]);
  const [status, setStatus] = useState<SummaryStatus>('loading');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const seq = useRef(0);
  const applied = useRef(0);
  const failedSeq = useRef(0);
  const loaded = useRef(false);
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (soon.current) { clearTimeout(soon.current); soon.current = null; }
    const mine = ++seq.current;
    if (!loaded.current) setStatus('loading'); // a Retry after a failed first load
    try {
      const data = await apiJson('/api/accounting/bank-account-summaries', undefined, LOAD_FAILED);
      if (mine < applied.current) return; // something newer already landed
      applied.current = mine;
      loaded.current = true;
      setAccounts(data.accounts);
      setStatus('ready'); setError(''); setStale(failedSeq.current > mine);
    } catch (err) {
      if (mine !== seq.current) return; // a failure of a superseded request says nothing about the newest
      log.error('Failed to load the bank account summaries', { error: err }, 'accounting-ui');
      failedSeq.current = mine;
      if (loaded.current) { setStale(true); return; }
      setError(apiErrorMessage(err, LOAD_FAILED)); setStatus('error');
    }
  }, []);

  const refreshSoon = useCallback(() => {
    if (soon.current) clearTimeout(soon.current);
    soon.current = setTimeout(() => { soon.current = null; void refresh(); }, SOON_MS);
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { if (soon.current) clearTimeout(soon.current); }, []);

  return { accounts, status, error, stale, refresh, refreshSoon };
}
