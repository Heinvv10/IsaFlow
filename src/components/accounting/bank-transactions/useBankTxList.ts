/**
 * useBankTxList - the bank-transactions page's list: loads the current account/tab/page/filters and keeps the answer.
 *
 *  - Only the LATEST request writes state: a slow older response never overwrites a newer one, and the latest load ends the
 *    loading state (silent or not), so a silent AI-poll tick that supersedes a visible load cannot strand it.
 *  - A silent reload (the AI poll) keeps the rows on screen: no skeleton, and its failure keeps them too - unless it
 *    superseded a visible load that never delivered, then the screen still holds the OLD view and the failure is shown.
 *  - `reload()` always loads the view on screen NOW (an Undo toast or a slow action outlives the render that offered it).
 *  - Nothing is fetched until the router can say what the URL is (`ready`): the first fetch is for the restored view.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import type { BankTx } from '@/components/accounting/BankTxTable';
import { bankTxQueryParams } from './bankTxQuery';
import { listKey } from './bankTxPageView';
import type { BankTxTab } from './BankTxTabs';
import type { UrlFilters } from './bankTxUrlState';

export const BANK_TX_LIST_PAGE_SIZE = 25;

export function useBankTxList(a: { selectedBank: string; ready: boolean; tab: BankTxTab; page: number; pageSize: number; filters: UrlFilters }) {
  const { selectedBank, ready, tab, page, pageSize, filters: v } = a;
  const [transactions, setTransactions] = useState<BankTx[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  // The total, and the account/tab/page it was counted for (a stale total is never shown; past-the-end shows the skeleton).
  const [loaded, setLoaded] = useState({ page: 1, total: 0, key: '' });
  const loadSeq = useRef(0), visibleSeq = useRef(0), goodSeq = useRef(0);

  const loadTransactions = useCallback(async (opts?: { silent?: boolean }) => {
    if (!ready) return; // the URL is not known yet: keep the skeleton, fetch nothing
    const seq = ++loadSeq.current, latest = () => seq === loadSeq.current;
    if (!selectedBank) { setIsLoading(false); setTransactions([]); setLoaded({ page, total: 0, key: '' }); return; }
    if (!opts?.silent) { visibleSeq.current = seq; setIsLoading(true); setError(''); }
    try {
      const params = bankTxQueryParams({ bankAccountId: selectedBank, tab, page, pageSize, fromDate: v.fromDate, toDate: v.toDate,
        fromAmount: v.fromAmount, toAmount: v.toAmount, search: v.search, sortOrder: v.sortOrder, allocationFilter: v.allocationFilter,
        txType: v.txType, allocType: v.allocType, hasSuggestion: v.hasSuggestion, reconFilter: v.reconFilter });
      const res = await apiFetch(`/api/accounting/bank-transactions?${params}`);
      await assertOk(res, 'Could not load transactions - try again');
      const json = await res.json();
      if (!latest()) return;
      const data = json.data || json;
      setTransactions(data.transactions || []); setLoaded({ page, total: data.total || 0, key: listKey(selectedBank, tab) });
      goodSeq.current = seq; setError('');
    } catch (err) {
      if (latest() && (!opts?.silent || visibleSeq.current > goodSeq.current)) {
        setTransactions([]); setLoaded({ page, total: 0, key: '' }); setError(apiErrorMessage(err, 'Could not load transactions - try again'));
      }
    } finally { if (latest()) setIsLoading(false); }
  }, [selectedBank, ready, tab, page, pageSize, v.fromDate, v.toDate, v.fromAmount, v.toAmount, v.search, v.sortOrder, v.allocationFilter, v.txType, v.allocType, v.hasSuggestion, v.reconFilter]);

  useEffect(() => { void loadTransactions(); }, [loadTransactions]);
  const latestLoad = useRef(loadTransactions);
  useEffect(() => { latestLoad.current = loadTransactions; });
  /** Loads the view on screen now (not the one the caller rendered with). */
  const reload = useCallback((opts?: { silent?: boolean }) => latestLoad.current(opts), []);

  return { transactions, setTransactions, isLoading, error, loaded, setLoaded, reload };
}
