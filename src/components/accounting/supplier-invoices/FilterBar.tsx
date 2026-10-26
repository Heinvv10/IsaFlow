/**
 * Top filter bar for the Supplier Invoices list — search, supplier typeahead,
 * date preset (a month, or a custom range), amount + balance ranges, and the
 * active filters as removable chips with "Clear all".
 */

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { SupplierTypeahead } from './SupplierTypeahead';
import { ActiveFilterChips, periodChipLabel, type ActiveFilterChip } from '../ActiveFilterChips';
import { wholeMonthOf } from '../invoicePeriod';
import { SUPPLIER_INVOICE_TAB_LABEL, type DatePreset, type SupplierInvoiceListFilters } from './listTypes';
import { DateField } from '@/components/ui/DateField';

interface Props {
  filters: SupplierInvoiceListFilters;
  setSearch: (s: string) => void;
  selectSupplier: (id: string, label: string) => void;
  clearSupplier: () => void;
  setDatePreset: (p: DatePreset) => void;
  setMonth: (yearMonth: string) => void;
  setTab: (t: 'all') => void;
  setCustomDate: (key: 'fromDate' | 'toDate', value: string) => void;
  setAmountRange: (key: 'fromAmount' | 'toAmount' | 'fromBalance' | 'toBalance', value: string) => void;
  resetFilters: () => void;
}

export function FilterBar({
  filters, setSearch, selectSupplier, clearSupplier,
  setDatePreset, setMonth, setTab, setCustomDate, setAmountRange, resetFilters,
}: Props) {
  // Local debounced search input — committed to the parent on a 300ms idle.
  const [searchInput, setSearchInput] = useState(filters.search);

  useEffect(() => { setSearchInput(filters.search); }, [filters.search]);

  useEffect(() => {
    if (searchInput === filters.search) return;
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.search, setSearch]);

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
          <input
            type="text"
            name="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search invoice #, supplier, reference, notes…"
            className="w-full pl-9 pr-9 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => { setSearchInput(''); setSearch(''); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <SupplierTypeahead
          selectedId={filters.supplierId}
          selectedLabel={filters.supplierLabel}
          onSelect={selectSupplier}
          onClear={clearSupplier}
          clearLabel="Clear supplier filter"
        />

        <select
          name="datePreset"
          value={filters.datePreset}
          onChange={(e) => setDatePreset(e.target.value as DatePreset)}
          className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
        >
          <option value="all">All dates</option>
          <option value="this_month">This month</option>
          <option value="last_month">Last month</option>
          <option value="last_30_days">Last 30 days</option>
          <option value="this_fy">This FY</option>
          <option value="last_fy">Last FY</option>
          <option value="month">Month…</option>
          <option value="custom">Custom</option>
        </select>

        {filters.datePreset === 'month' && (
          <input
            type="month"
            name="month"
            aria-label="Invoice month"
            value={wholeMonthOf(filters.fromDate, filters.toDate) ?? ''}
            onChange={(e) => setMonth(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
          />
        )}

        {filters.datePreset === 'custom' && (
          <>
            <DateField
              label="From date"
              name="fromDate"
              value={filters.fromDate || null}
              onChange={(iso, v) => { if (v.valid) setCustomDate('fromDate', iso ?? ''); }}
            />
            <DateField
              label="To date"
              name="toDate"
              value={filters.toDate || null}
              onChange={(iso, v) => { if (v.valid) setCustomDate('toDate', iso ?? ''); }}
            />
          </>
        )}

      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <RangeInput label="Total" minName="fromAmount" maxName="toAmount" filters={filters} onChange={setAmountRange} />
        <span className="text-slate-300 dark:text-slate-600">|</span>
        <RangeInput label="Outstanding" minName="fromBalance" maxName="toBalance" filters={filters} onChange={setAmountRange} />
      </div>

      <ActiveFilterChips
        chips={activeChips(filters, { setTab, setSearch, clearSupplier, setDatePreset, setAmountRange })}
        onClearAll={() => { setSearchInput(''); resetFilters(); }}
      />
    </div>
  );
}

type ChipActions = Pick<Props, 'setTab' | 'setSearch' | 'clearSupplier' | 'setDatePreset' | 'setAmountRange'>;

function activeChips(f: SupplierInvoiceListFilters, a: ChipActions): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (f.tab !== 'all') chips.push({ key: 'status', label: `Status: ${SUPPLIER_INVOICE_TAB_LABEL[f.tab]}`, onRemove: () => a.setTab('all') });
  if (f.search) chips.push({ key: 'search', label: `Search: “${f.search}”`, onRemove: () => a.setSearch('') });
  if (f.supplierId) chips.push({ key: 'supplier', label: `Supplier: ${f.supplierLabel || 'selected'}`, onRemove: a.clearSupplier });
  if (f.fromDate || f.toDate) {
    chips.push({
      key: 'period',
      label: periodChipLabel(f.fromDate, f.toDate, wholeMonthOf(f.fromDate, f.toDate)),
      onRemove: () => a.setDatePreset('all'),
    });
  }
  const ranges = [['fromAmount', 'Total ≥'], ['toAmount', 'Total ≤'], ['fromBalance', 'Outstanding ≥'], ['toBalance', 'Outstanding ≤']] as const;
  for (const [key, label] of ranges) {
    if (f[key]) chips.push({ key, label: `${label} ${f[key]}`, onRemove: () => a.setAmountRange(key, '') });
  }
  return chips;
}

interface RangeProps {
  label: string;
  minName: 'fromAmount' | 'fromBalance';
  maxName: 'toAmount' | 'toBalance';
  filters: SupplierInvoiceListFilters;
  onChange: (key: 'fromAmount' | 'toAmount' | 'fromBalance' | 'toBalance', value: string) => void;
}

function RangeInput({ label, minName, maxName, filters, onChange }: RangeProps) {
  return (
    <>
      <span className="text-slate-500 dark:text-slate-400 font-medium">{label}</span>
      <input
        type="number"
        name={minName}
        value={filters[minName]}
        onChange={(e) => onChange(minName, e.target.value)}
        placeholder="min"
        className="w-28 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
      />
      <span className="text-slate-400">–</span>
      <input
        type="number"
        name={maxName}
        value={filters[maxName]}
        onChange={(e) => onChange(maxName, e.target.value)}
        placeholder="max"
        className="w-28 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
      />
    </>
  );
}
