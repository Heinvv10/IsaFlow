/**
 * useRemoveRows - lines that left the tab (accepted, reviewed, allocated, deleted) come off the screen at once and the
 * list's count drops with them (WP4a); the reload that follows only tops the page up, so nothing waits on the network.
 * The count falls by the lines actually taken off THIS list, not by the number of ids named: a line that is not on the
 * current page (it was reloaded away meanwhile) must not make the total wrong.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { BankTx } from '@/components/accounting/BankTxTable';

export function useRemoveRows<L extends { total: number }>(
  transactions: BankTx[], setTransactions: Dispatch<SetStateAction<BankTx[]>>, setLoaded: Dispatch<SetStateAction<L>>,
) {
  const shown = useRef(transactions);
  useEffect(() => { shown.current = transactions; });
  return useCallback((ids: string[]) => {
    const gone = new Set(ids);
    const removed = shown.current.filter(t => gone.has(t.id)).length;
    if (removed === 0) return;
    setTransactions(prev => prev.filter(t => !gone.has(t.id)));
    setLoaded(l => ({ ...l, total: Math.max(0, l.total - removed) }));
  }, [setTransactions, setLoaded]);
}
