/**
 * Top filter bar for the Supplier Invoices list — search, supplier typeahead,
 * date preset (and custom range), amount + balance ranges, reset button.
 */

import { useEffect, useState } from 'react';
import { Search, X, RotateCcw } from 'lucide-react';
import { SupplierTypeahead } from './SupplierTypeahead';
import type { DatePreset, SupplierInvoiceListFilters } from './listTypes';

interface Props {
  filters: SupplierInvoiceListFilters;
  filtersActive: boolean;
  setSearch: (s: string) => void;
  selectSupplier: (id: string, label: string) => void;
  clearSupplier: () => void;
  setDatePreset: (p: DatePreset) => void;
  setCustomDate: (key: 'fromDate' | 'toDate', value: string) => void;
  setAmountRange: (key: 'fromAmount' | 'toAmount' | 'fromBalance' | 'toBalance', value: string) => void;
  resetFilters: () => void;
}

export function FilterBar({
  filters, filtersActive, setSearch, selectSupplier, clearSupplier,
  setDatePreset, setCustomDate, setAmountRange, resetFilters,
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
          <option value="custom">Custom</option>
        </select>

        {filters.datePreset === 'custom' && (
          <>
            <input
              type="date"
              name="fromDate"
              value={filters.fromDate}
              onChange={(e) => setCustomDate('fromDate', e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
            />
            <input
              type="date"
              name="toDate"
              value={filters.toDate}
              onChange={(e) => setCustomDate('toDate', e.target.value)}
              className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
            />
          </>
        )}

        {filtersActive && (
          <button
            type="button"
            onClick={resetFilters}
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <RangeInput label="Total" minName="fromAmount" maxName="toAmount" filters={filters} onChange={setAmountRange} />
        <span className="text-slate-300 dark:text-slate-600">|</span>
        <RangeInput label="Outstanding" minName="fromBalance" maxName="toBalance" filters={filters} onChange={setAmountRange} />
      </div>
    </div>
  );
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
