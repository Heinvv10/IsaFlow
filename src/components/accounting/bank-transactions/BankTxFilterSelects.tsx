/**
 * BankTxFilterSelects — the bank transactions toolbar's sort and filter selects. Kit Selects at the compact size; each
 * label is visually hidden, the trigger shows the current choice ("All Status"). BankTxStatusSelect is the tab's status
 * filter and stays on the bar (allocation status on New, reconciliation on Reviewed); BankTxFilterSelects holds the rest
 * (sort, spent/received, allocation type, suggestion), folded in the Filters panel (WP4b).
 */

import { Select, type SelectOption } from '@/components/ui/Select';
import type { BankTxFiltersProps } from './BankTxFilters';

type Props = Pick<BankTxFiltersProps,
  'tab' | 'sortOrder' | 'allocationFilter' | 'txType' | 'allocType' | 'hasSuggestion' | 'reconFilter'
  | 'onSortOrderChange' | 'onAllocationFilterChange' | 'onTxTypeChange' | 'onAllocTypeChange' | 'onHasSuggestionChange'
  | 'onReconFilterChange'>;

const SORT: SelectOption[] = [{ value: 'desc', label: 'Newest First' }, { value: 'asc', label: 'Oldest First' }];
const STATUS: SelectOption[] = [
  { value: 'all', label: 'All Status' }, { value: 'unallocated', label: 'Unallocated' },
  { value: 'suggested', label: 'Suggested' }, { value: 'allocated', label: 'Allocated' },
];
const TX_TYPE: SelectOption[] = [{ value: 'all', label: 'All Types' }, { value: 'spent', label: 'Spent' }, { value: 'received', label: 'Received' }];
const ALLOC_TYPE: SelectOption[] = [
  { value: 'all', label: 'All allocation types' }, { value: 'account', label: 'Account' }, { value: 'supplier', label: 'Supplier' },
  { value: 'customer', label: 'Customer' }, { value: 'transfer', label: 'Transfer' },
];
const RECON: SelectOption[] = [
  { value: 'all', label: 'All Reviewed' }, { value: 'unreconciled', label: 'Not Reconciled' },
  { value: 'reconciled', label: 'Reconciled' },
];
const SUGGESTION: SelectOption[] = [{ value: 'all', label: 'All Suggestions' }, { value: 'yes', label: 'Has Suggestion' }, { value: 'no', label: 'No Suggestion' }];

/** A filter always holds a value: the kit's clear (null) never reaches the page. */
function pick<T extends string>(on: (v: T) => void) {
  return (v: string | null) => { if (v) on(v as T); };
}

/** The tab's status filter: allocation status on New, reconciliation on Reviewed, nothing elsewhere. */
export function BankTxStatusSelect({ tab, allocationFilter, reconFilter, onAllocationFilterChange, onReconFilterChange }:
  Pick<Props, 'tab' | 'allocationFilter' | 'reconFilter' | 'onAllocationFilterChange' | 'onReconFilterChange'>) {
  if (tab === 'new') {
    return <Select label="Allocation status" labelClassName="sr-only" size="xs" className="w-32"
      options={STATUS} value={allocationFilter} onChange={pick(onAllocationFilterChange)} />;
  }
  if (tab === 'reviewed') {
    return <Select label="Reconciliation" labelClassName="sr-only" size="xs" className="w-36"
      options={RECON} value={reconFilter} onChange={pick(onReconFilterChange)} />;
  }
  return null;
}

export function BankTxFilterSelects({ sortOrder, txType, allocType, hasSuggestion, onSortOrderChange, onTxTypeChange, onAllocTypeChange, onHasSuggestionChange }:
  Pick<Props, 'sortOrder' | 'txType' | 'allocType' | 'hasSuggestion' | 'onSortOrderChange' | 'onTxTypeChange' | 'onAllocTypeChange' | 'onHasSuggestionChange'>) {
  return (
    <>
      <Select label="Sort order" labelClassName="sr-only" size="sm" className="w-32"
        options={SORT} value={sortOrder} onChange={pick(onSortOrderChange)} />
      <Select label="Spent or received" labelClassName="sr-only" size="sm" className="w-28"
        options={TX_TYPE} value={txType} onChange={pick(onTxTypeChange)} />
      <Select label="Allocation type" labelClassName="sr-only" size="sm" className="w-44"
        options={ALLOC_TYPE} value={allocType} onChange={pick(onAllocTypeChange)} />
      <Select label="Suggestion" labelClassName="sr-only" size="sm" className="w-36"
        options={SUGGESTION} value={hasSuggestion} onChange={pick(onHasSuggestionChange)} />
    </>
  );
}
