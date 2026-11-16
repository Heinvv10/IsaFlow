/**
 * useBankTxSummary — the bank accounts of the bank-transactions page, each with the figures its card, tiles and
 * statement panel show (GET /api/accounting/bank-account-summaries; WP1 "Truthful numbers", PR-C).
 *
 * `refresh()` carries a sequence guard: only the newest call writes state, so a slow older response (a refresh fired
 * before a mutation) cannot put pre-mutation figures back over the post-mutation ones.
 *
 * Failure is never an empty account list: a failed FIRST load is `status: 'error'` (the page shows the message and
 * Retry, not "No bank accounts configured"); a failed later load keeps the last data and sets `stale`.
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
}

const LOAD_FAILED = 'Could not load the bank accounts - try again';

export function useBankTxSummary(): BankTxSummary {
  const [accounts, setAccounts] = useState<BankAccountSummary[]>([]);
  const [status, setStatus] = useState<SummaryStatus>('loading');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const seq = useRef(0);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    if (!loaded.current) setStatus('loading'); // a Retry after a failed first load
    try {
      const data = await apiJson('/api/accounting/bank-account-summaries', undefined, LOAD_FAILED);
      if (mine !== seq.current) return;
      loaded.current = true;
      setAccounts(data.accounts);
      setStatus('ready'); setError(''); setStale(false);
    } catch (err) {
      if (mine !== seq.current) return;
      log.error('Failed to load the bank account summaries', { error: err }, 'accounting-ui');
      if (loaded.current) { setStale(true); return; }
      setError(apiErrorMessage(err, LOAD_FAILED)); setStatus('error');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { accounts, status, error, stale, refresh };
}
