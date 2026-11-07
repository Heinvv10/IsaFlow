/**
 * BankTxFilterSelects — the bank transactions toolbar's sort and filter selects (sort order, allocation status,
 * spent/received, category, suggestion).
 */

import type { BankTxFiltersProps } from './BankTxFilters';

type Props = Pick<BankTxFiltersProps,
  'tab' | 'sortOrder' | 'allocationFilter' | 'txType' | 'allocType' | 'hasSuggestion'
  | 'onSortOrderChange' | 'onAllocationFilterChange' | 'onTxTypeChange' | 'onAllocTypeChange' | 'onHasSuggestionChange'>;

export function BankTxFilterSelects({
  tab, sortOrder, allocationFilter, txType, allocType, hasSuggestion,
  onSortOrderChange, onAllocationFilterChange, onTxTypeChange, onAllocTypeChange, onHasSuggestionChange,
}: Props) {
  return (
    <>
      <select
        value={sortOrder}
        onChange={e => onSortOrderChange(e.target.value as 'asc' | 'desc')}
        aria-label="Sort order"
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="desc">Newest First</option>
        <option value="asc">Oldest First</option>
      </select>

      {tab === 'new' && (
        <select
          value={allocationFilter}
          onChange={e => onAllocationFilterChange(e.target.value as 'all' | 'unallocated' | 'suggested' | 'allocated')}
          aria-label="Allocation status"
          className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
        >
          <option value="all">All Status</option>
          <option value="unallocated">Unallocated</option>
          <option value="suggested">Suggested</option>
          <option value="allocated">Allocated</option>
        </select>
      )}

      <select
        value={txType}
        onChange={e => onTxTypeChange(e.target.value as 'all' | 'spent' | 'received')}
        aria-label="Spent or received"
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="all">All Types</option>
        <option value="spent">Spent</option>
        <option value="received">Received</option>
      </select>

      <select
        value={allocType}
        onChange={e => onAllocTypeChange(e.target.value as 'all' | 'account' | 'supplier' | 'customer' | 'transfer')}
        aria-label="Category"
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="all">All Categories</option>
        <option value="account">Account</option>
        <option value="supplier">Supplier</option>
        <option value="customer">Customer</option>
        <option value="transfer">Transfer</option>
      </select>

      <select
        value={hasSuggestion}
        onChange={e => onHasSuggestionChange(e.target.value as 'all' | 'yes' | 'no')}
        aria-label="Suggestion"
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="all">All Suggestions</option>
        <option value="yes">Has Suggestion</option>
        <option value="no">No Suggestion</option>
      </select>
    </>
  );
}
