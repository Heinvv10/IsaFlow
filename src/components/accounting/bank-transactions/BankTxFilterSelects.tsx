/**
 * BankTxFilterSelects — the bank transactions toolbar's sort and filter selects (sort order, allocation status,
 * spent/received, category, suggestion). Kit Selects at the compact size; each label is visually hidden, the
 * trigger shows the current choice ("All Status").
 */

import { Select, type SelectOption } from '@/components/ui/Select';
import type { BankTxFiltersProps } from './BankTxFilters';

type Props = Pick<BankTxFiltersProps,
  'tab' | 'sortOrder' | 'allocationFilter' | 'txType' | 'allocType' | 'hasSuggestion'
  | 'onSortOrderChange' | 'onAllocationFilterChange' | 'onTxTypeChange' | 'onAllocTypeChange' | 'onHasSuggestionChange'>;

const SORT: SelectOption[] = [{ value: 'desc', label: 'Newest First' }, { value: 'asc', label: 'Oldest First' }];
const STATUS: SelectOption[] = [
  { value: 'all', label: 'All Status' }, { value: 'unallocated', label: 'Unallocated' },
  { value: 'suggested', label: 'Suggested' }, { value: 'allocated', label: 'Allocated' },
];
const TX_TYPE: SelectOption[] = [{ value: 'all', label: 'All Types' }, { value: 'spent', label: 'Spent' }, { value: 'received', label: 'Received' }];
const CATEGORY: SelectOption[] = [
  { value: 'all', label: 'All Categories' }, { value: 'account', label: 'Account' }, { value: 'supplier', label: 'Supplier' },
  { value: 'customer', label: 'Customer' }, { value: 'transfer', label: 'Transfer' },
];
const SUGGESTION: SelectOption[] = [{ value: 'all', label: 'All Suggestions' }, { value: 'yes', label: 'Has Suggestion' }, { value: 'no', label: 'No Suggestion' }];

/** A filter always holds a value: the kit's clear (null) never reaches the page. */
function pick<T extends string>(on: (v: T) => void) {
  return (v: string | null) => { if (v) on(v as T); };
}

export function BankTxFilterSelects({
  tab, sortOrder, allocationFilter, txType, allocType, hasSuggestion,
  onSortOrderChange, onAllocationFilterChange, onTxTypeChange, onAllocTypeChange, onHasSuggestionChange,
}: Props) {
  return (
    <>
      <Select label="Sort order" labelClassName="sr-only" size="sm" className="w-32"
        options={SORT} value={sortOrder} onChange={pick(onSortOrderChange)} />
      {tab === 'new' && (
        <Select label="Allocation status" labelClassName="sr-only" size="sm" className="w-32"
          options={STATUS} value={allocationFilter} onChange={pick(onAllocationFilterChange)} />
      )}
      <Select label="Spent or received" labelClassName="sr-only" size="sm" className="w-28"
        options={TX_TYPE} value={txType} onChange={pick(onTxTypeChange)} />
      <Select label="Category" labelClassName="sr-only" size="sm" className="w-36"
        options={CATEGORY} value={allocType} onChange={pick(onAllocTypeChange)} />
      <Select label="Suggestion" labelClassName="sr-only" size="sm" className="w-36"
        options={SUGGESTION} value={hasSuggestion} onChange={pick(onHasSuggestionChange)} />
    </>
  );
}
