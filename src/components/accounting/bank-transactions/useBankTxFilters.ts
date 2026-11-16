/**
 * useBankTxFilters - every filter of the bank-transactions list in one place (WP3): search (debounced), dates, amount
 * range, sort, allocation / type / category / suggestion / reconciliation. `activeLabels` names what narrows the list
 * ("Search "rent"", "From 2026-01-01", ...), `clear()` drops them all (the sort is a view choice, not a filter), and
 * `resetForAccount()` returns EVERYTHING, sort included, to its default: a search or date range typed for one account
 * must not silently narrow the next.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReconFilter } from '@/modules/accounting/services/bank/bankTxTabCond';

export type AllocationFilter = 'all' | 'unallocated' | 'suggested' | 'allocated';
export type TxTypeFilter = 'all' | 'spent' | 'received';
export type AllocTypeFilter = 'all' | 'account' | 'supplier' | 'customer' | 'transfer';
export type HasSuggestionFilter = 'all' | 'yes' | 'no';

export function useBankTxFilters(setPage: (n: number) => void) {
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [fromAmount, setFromAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [allocationFilter, setAllocationFilter] = useState<AllocationFilter>('all');
  const [txType, setTxType] = useState<TxTypeFilter>('all');
  const [allocType, setAllocType] = useState<AllocTypeFilter>('all');
  const [hasSuggestion, setHasSuggestion] = useState<HasSuggestionFilter>('all');
  const [reconFilter, setReconFilter] = useState<ReconFilter>('all');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search - 500ms. Only a changed search resets to page 1 (the mount timer used to undo a page-3 click).
  useEffect(() => {
    if (searchTerm === debouncedSearch) return;
    debounceTimer.current = setTimeout(() => { setDebouncedSearch(searchTerm); setPage(1); }, 500);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchTerm, debouncedSearch, setPage]);

  const activeLabels: string[] = [];
  if (debouncedSearch) activeLabels.push(`Search "${debouncedSearch}"`);
  if (fromDate) activeLabels.push(`From ${fromDate}`);
  if (toDate) activeLabels.push(`To ${toDate}`);
  if (fromAmount) activeLabels.push(`Min R${fromAmount}`);
  if (toAmount) activeLabels.push(`Max R${toAmount}`);
  if (allocationFilter !== 'all') activeLabels.push(`Allocation: ${allocationFilter}`);
  if (txType !== 'all') activeLabels.push(`Type: ${txType}`);
  if (allocType !== 'all') activeLabels.push(`Category: ${allocType}`);
  if (hasSuggestion !== 'all') activeLabels.push(`Suggestion: ${hasSuggestion}`);
  if (reconFilter !== 'all') activeLabels.push(`Reconciliation: ${reconFilter}`);

  /** The select filters only: what a tab change resets. */
  const resetSelects = useCallback(() => {
    setAllocationFilter('all'); setTxType('all'); setAllocType('all'); setHasSuggestion('all'); setReconFilter('all');
  }, []);
  /** Every filter (the sort stays). */
  const clear = useCallback(() => {
    resetSelects();
    setSearchTerm(''); setDebouncedSearch(''); setFromDate(''); setToDate(''); setFromAmount(''); setToAmount('');
    setPage(1);
  }, [resetSelects, setPage]);
  /** Everything, including the sort: an account switch starts the next account from its defaults. */
  const resetForAccount = useCallback(() => { clear(); setSortOrder('desc'); }, [clear]);

  return {
    searchTerm, setSearchTerm, debouncedSearch, fromDate, setFromDate, toDate, setToDate, fromAmount, setFromAmount,
    toAmount, setToAmount, sortOrder, setSortOrder, allocationFilter, setAllocationFilter, txType, setTxType,
    allocType, setAllocType, hasSuggestion, setHasSuggestion, reconFilter, setReconFilter,
    activeLabels, resetSelects, clear, resetForAccount,
  };
}

export type BankTxFilterState = ReturnType<typeof useBankTxFilters>;
