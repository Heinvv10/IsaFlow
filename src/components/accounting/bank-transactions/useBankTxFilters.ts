/**
 * useBankTxFilters - every filter of the bank-transactions list in one place (WP3): search (debounced), dates, amount
 * range, sort, allocation / type / category / suggestion / reconciliation. `activeLabels` names what narrows or
 * reorders the list ("Search "rent"", "From 2026-01-01", "Sort: oldest first", ...), `clear()` drops them all, sort
 * included (WP4b: the sort folds behind Filters with the rest, so it is listed and cleared with them), and
 * `resetForAccount()` does the same: a search or date range typed for one account must not silently narrow the next.
 * The page size is kept by both.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReconFilter } from '@/modules/accounting/services/bank/bankTxTabCond';
import type { BankTxPageSize, UrlFilters } from './bankTxUrlState';
import { writePageSizePref } from './bankTxPageSizePref';

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
  // Rows per page: a view choice, so Clear and an account switch keep it (only the URL sets it back).
  const [pageSize, setPageSizeState] = useState<BankTxPageSize>(25);
  // Bumped by Clear and by an account switch: an amount input holding a draft that was never sent (invalid) resets with it.
  const [resetTick, setResetTick] = useState(0);
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
  if (fromAmount) activeLabels.push(`Min amount ${fromAmount}`);
  if (toAmount) activeLabels.push(`Max amount ${toAmount}`);
  if (allocationFilter !== 'all') activeLabels.push(`Allocation: ${allocationFilter}`);
  if (txType !== 'all') activeLabels.push(`Type: ${txType}`);
  if (allocType !== 'all') activeLabels.push(`Allocation type: ${allocType}`);
  if (hasSuggestion !== 'all') activeLabels.push(`Suggestion: ${hasSuggestion}`);
  if (reconFilter !== 'all') activeLabels.push(`Reconciliation: ${reconFilter}`);
  // Not a narrowing, but a non-default order is folded behind Filters at a narrow width: say so, and Clear resets it.
  if (sortOrder !== 'desc') activeLabels.push('Sort: oldest first');

  /** The select filters only: what a tab change resets. */
  const resetSelects = useCallback(() => {
    setAllocationFilter('all'); setTxType('all'); setAllocType('all'); setHasSuggestion('all'); setReconFilter('all');
  }, []);
  /** Every filter, and the sort (it is listed among them). The page size stays. */
  const clear = useCallback(() => {
    resetSelects(); setSortOrder('desc');
    setSearchTerm(''); setDebouncedSearch(''); setFromDate(''); setToDate(''); setFromAmount(''); setToAmount(''); setResetTick(t => t + 1);
    setPage(1);
  }, [resetSelects, setPage]);
  /** Everything: an account switch starts the next account from its defaults (the page size is kept). */
  const resetForAccount = useCallback(() => { clear(); }, [clear]);

  /** A new page size starts the list from page 1 (page 3 of 25 rows is not page 3 of 100). */
  const setPageSize = useCallback((n: BankTxPageSize) => { setPageSizeState(n); writePageSizePref(n); setPage(1); }, [setPage]);

  /** Sets every filter at once from a view (the URL): the search takes effect at once, no debounce, and the page is the caller's. */
  const apply = useCallback((v: UrlFilters) => {
    setSearchTerm(v.search); setDebouncedSearch(v.search); setFromDate(v.fromDate); setToDate(v.toDate);
    setFromAmount(v.fromAmount); setToAmount(v.toAmount); setSortOrder(v.sortOrder); setAllocationFilter(v.allocationFilter);
    setTxType(v.txType); setAllocType(v.allocType); setHasSuggestion(v.hasSuggestion); setReconFilter(v.reconFilter);
    setPageSizeState(v.pageSize);
    setResetTick(t => t + 1);
  }, []);
  /** What the list is filtered by right now (the committed search, not what is still being typed). */
  const values: UrlFilters = { search: debouncedSearch, fromDate, toDate, fromAmount, toAmount, sortOrder, allocationFilter, txType, allocType, hasSuggestion, reconFilter, pageSize };

  return {
    apply, values,
    searchTerm, setSearchTerm, debouncedSearch, fromDate, setFromDate, toDate, setToDate, fromAmount, setFromAmount,
    toAmount, setToAmount, sortOrder, setSortOrder, allocationFilter, setAllocationFilter, txType, setTxType,
    allocType, setAllocType, hasSuggestion, setHasSuggestion, reconFilter, setReconFilter, pageSize, setPageSize,
    activeLabels, resetSelects, clear, resetForAccount, resetTick,
  };
}

export type BankTxFilterState = ReturnType<typeof useBankTxFilters>;
