/**
 * Filter bar for the customer invoice list: status, debounced search, customer
 * typeahead, invoice-date period, the aging chips, and the active filters as
 * removable chips. All state lives in useCustomerInvoiceListState (the URL).
 */

import { useEffect, useState } from 'react';
import { ARFilters, type AgingFilterId } from '@/components/invoices/ARFilters';
import { ActiveFilterChips, periodChipLabel, type ActiveFilterChip } from '../ActiveFilterChips';
import { PeriodControl } from '../PeriodControl';
import { wholeMonthOf } from '../invoicePeriod';
import { CustomerTypeahead } from './CustomerTypeahead';
import { AR_STATUSES, type ARStatus } from './listQuery';
import type { CustomerInvoiceListState } from './useCustomerInvoiceListState';

const INPUT = 'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';

const AGING_LABELS: Record<AgingFilterId, string> = {
  'due-soon': 'Due soon',
  'overdue-90': 'Overdue 90+',
  'viewed-unpaid': 'Viewed, unpaid',
};

function statusLabel(s: ARStatus): string {
  return s === 'all' ? 'All Statuses' : s.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
}

interface Props {
  state: CustomerInvoiceListState;
  total: number | null;
}

export function ARFilterBar({ state, total }: Props) {
  const { filters, setSearch } = state;
  const [searchInput, setSearchInput] = useState(filters.search);

  useEffect(() => { setSearchInput(filters.search); }, [filters.search]);

  useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.search, setSearch]);

  const chips: ActiveFilterChip[] = [];
  if (filters.status !== 'all') chips.push({ key: 'status', label: `Status: ${statusLabel(filters.status)}`, onRemove: () => state.setStatus('all') });
  if (filters.search) chips.push({ key: 'search', label: `Search: “${filters.search}”`, onRemove: () => state.setSearch('') });
  if (filters.customerId) chips.push({ key: 'customer', label: `Customer: ${state.customerLabel || 'selected'}`, onRemove: state.clearCustomer });
  if (filters.from || filters.to) {
    chips.push({
      key: 'period',
      label: periodChipLabel(filters.from, filters.to, wholeMonthOf(filters.from, filters.to)),
      onRemove: () => state.setRange('', ''),
    });
  }
  for (const a of filters.aging) {
    chips.push({ key: `aging-${a}`, label: AGING_LABELS[a], onRemove: () => state.setAging(filters.aging.filter(x => x !== a)) });
  }

  return (
    <div className="flex flex-col gap-3 mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          name="statusFilter"
          aria-label="Status"
          value={filters.status}
          onChange={e => state.setStatus(e.target.value as ARStatus)}
          className={INPUT}
        >
          {AR_STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </select>
        <input
          type="text"
          name="search"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search invoice # or client..."
          className={`${INPUT} w-64`}
        />
        <CustomerTypeahead
          selectedId={filters.customerId}
          selectedLabel={state.customerLabel}
          onSelect={state.selectCustomer}
          onClear={state.clearCustomer}
          inputClassName={INPUT}
        />
        <PeriodControl from={filters.from} to={filters.to} onChange={state.setRange} inputClassName={INPUT} />
        {total !== null && (
          <span className="text-sm text-[var(--ff-text-secondary)]">{total} invoice{total !== 1 ? 's' : ''}</span>
        )}
      </div>
      <ARFilters selectedFilters={filters.aging} onChange={state.setAging} />
      <ActiveFilterChips chips={chips} onClearAll={() => { setSearchInput(''); state.clearAll(); }} />
    </div>
  );
}
