/**
 * useRemoveRows - lines that left the tab (accepted, reviewed, allocated, deleted) come off the screen at once and the
 * list's count drops with them (WP4a); the reload that follows only tops the page up, so nothing waits on the network.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { BankTx } from '@/components/accounting/BankTxTable';

export function useRemoveRows<L extends { total: number }>(setTransactions: Dispatch<SetStateAction<BankTx[]>>, setLoaded: Dispatch<SetStateAction<L>>) {
  return useCallback((ids: string[]) => {
    const gone = new Set(ids);
    setTransactions(prev => prev.filter(t => !gone.has(t.id)));
    setLoaded(l => ({ ...l, total: Math.max(0, l.total - ids.length) }));
  }, [setTransactions, setLoaded]);
}
