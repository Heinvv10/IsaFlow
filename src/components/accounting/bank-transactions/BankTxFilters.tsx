/**
 * BankTxFilters — the bank transactions toolbar (WP4b). One row: the page actions (Refresh, Smart Categorize, New
 * Transaction, and a More menu for Import / Export / Export all / Recon report) — or, while rows are ticked, the
 * contextual selection bar in their place, the whole bar then sticking to the top of the list — then search, the tab's status filter, the Filters toggle, the column toggles
 * and the row range. The less-used filters (dates, amounts, sort, spent/received, allocation type, suggestion) fold into
 * a second row behind "Filters": open by default on a wide screen (>= 1536px) or while one of them narrows the list, so
 * at 1366px the list starts high enough to show eight rows.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, Search, Zap, Plus, SlidersHorizontal } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { DebouncedAmountInput } from './DebouncedAmountInput';
import { BankTxFilterSelects, BankTxStatusSelect } from './BankTxFilterSelects';
import { BankTxMoreMenu } from './BankTxMoreMenu';
import { BankTxSelectionBar } from './BankTxSelectionBar';
import type { ReconFilter } from '@/modules/accounting/services/bank/bankTxTabCond';

type Tab = import('./BankTxTabs').BankTxTab;

/** Wide enough that the folded filters fit beside the list without costing it rows. */
const WIDE_QUERY = '(min-width: 1536px)';
const PILL = 'flex min-h-7 items-center gap-1 px-2.5 rounded border text-xs';

/** Whether the Filters panel is open: the user's choice once made, else open on a wide screen or while a folded filter is set. */
function useFoldedFilters(narrowing: boolean) {
  const [wide, setWide] = useState(false);
  useEffect(() => { if (typeof window.matchMedia === 'function') setWide(window.matchMedia(WIDE_QUERY).matches); }, []);
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (wide || narrowing);
  return { open, toggle: () => setChoice(!open) };
}

export interface BankTxFiltersProps {
  tab: Tab;
  page: number;
  total: number;
  pageSize: number;
  selectedCount: number;
  selectedBank: string;
  smartRunning: boolean;
  showCC: boolean;
  showBU: boolean;
  showBatchEdit: boolean;
  searchTerm: string;
  fromDate: string;
  toDate: string;
  fromAmount: string;
  toAmount: string;
  sortOrder: 'asc' | 'desc';
  allocationFilter: 'all' | 'unallocated' | 'suggested' | 'allocated';
  txType: 'all' | 'spent' | 'received';
  allocType: 'all' | 'account' | 'supplier' | 'customer' | 'transfer';
  hasSuggestion: 'all' | 'yes' | 'no';
  reconFilter: ReconFilter;
  /** Keys of the mutating buttons running (useBankTxBusy): 'review', 'batch-allocate', 'delete', 'apply-rules'. */
  busy?: ReadonlySet<string>;
  /** "Allocating 3 of 12" while a batch runs. */
  progress?: { key: string; done: number; total: number } | null;
  /** Changes when the filters are cleared or the account switches: the amount inputs drop any unsent draft. */
  resetKey?: number;
  onRefresh: () => void;
  onBulkAccept: () => void;
  onBatchAccept: () => void;
  onBatchDelete: () => void;
  onToggleBatchEdit: () => void;
  onExport: () => void;
  onExportAll: () => void;
  onApplyRules: () => void;
  onDownloadReport: () => void;
  onSearchChange: (v: string) => void;
  onFromDateChange: (v: string) => void;
  onToDateChange: (v: string) => void;
  onFromAmountChange: (v: string) => void;
  onToAmountChange: (v: string) => void;
  onSortOrderChange: (v: 'asc' | 'desc') => void;
  onAllocationFilterChange: (v: 'all' | 'unallocated' | 'suggested' | 'allocated') => void;
  onTxTypeChange: (v: 'all' | 'spent' | 'received') => void;
  onAllocTypeChange: (v: 'all' | 'account' | 'supplier' | 'customer' | 'transfer') => void;
  onHasSuggestionChange: (v: 'all' | 'yes' | 'no') => void;
  onReconFilterChange: (v: ReconFilter) => void;
  onToggleCC: () => void;
  onToggleBU: () => void;
  /** Drops the ticked rows (the selection bar's Clear selection). */
  onClearSelection: () => void;
}

export function BankTxFilters(p: BankTxFiltersProps) {
  const {
    tab, page, total, pageSize, selectedCount, selectedBank, smartRunning, busy, progress, resetKey, showCC, showBU,
    searchTerm, fromDate, toDate, fromAmount, toAmount, sortOrder, txType, allocType, hasSuggestion,
    onRefresh, onApplyRules, onSearchChange, onFromDateChange, onToDateChange, onFromAmountChange, onToAmountChange,
    onToggleCC, onToggleBU,
  } = p;
  // The folded choices that are not at their default (a non-default sort counts: it is out of sight too).
  const folded = [fromDate, toDate, fromAmount, toAmount].filter(Boolean).length + [txType, allocType, hasSuggestion].filter(v => v !== 'all').length
    + (sortOrder !== 'desc' ? 1 : 0);
  const panel = useFoldedFilters(folded > 0);
  const toggleClass = (on: boolean) => `px-2 min-h-7 rounded text-xs font-medium transition-colors ${on
    ? 'bg-blue-500/20 text-blue-700 dark:text-blue-400'
    : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] border border-[var(--ff-border-light)]'}`;
  return (
    // While rows are ticked the bar sticks to the top of the scrolling list, so it stays on screen at row 80 of 100.
    <div data-testid="bank-tx-toolbar" className={`px-6 py-1 border-b border-[var(--ff-border-light)] ${selectedCount > 0
      ? 'sticky top-0 z-20 bg-[var(--ff-bg-secondary)] shadow-sm' : 'bg-[var(--ff-bg-secondary)]/30'}`}>
      <span role="status" aria-live="polite" className="sr-only" data-testid="bank-tx-progress-live">
        {progress?.key === 'batch-allocate' ? `Allocating ${progress.done + 1} of ${progress.total}` : ''}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {selectedCount > 0 ? (
          <BankTxSelectionBar count={selectedCount} showActions={tab === 'new'} busy={busy} progress={progress}
            onBulkAccept={p.onBulkAccept} onBatchAccept={p.onBatchAccept} onBatchDelete={p.onBatchDelete}
            onToggleBatchEdit={p.onToggleBatchEdit} onClear={p.onClearSelection} />
        ) : (
          <>
            <button type="button" onClick={onRefresh} title="Reload the list and the figures"
              className="flex min-h-7 items-center gap-1 px-1.5 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button type="button" onClick={onApplyRules} disabled={!selectedBank || smartRunning || busy?.has('apply-rules')}
              title="Apply bank rules, then smart-categorize remaining transactions using patterns and historical data"
              className={`${PILL} border-yellow-500/40 text-yellow-700 dark:text-yellow-500 hover:text-yellow-800 dark:hover:text-yellow-400 hover:border-yellow-400 disabled:opacity-30`}>
              {smartRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {smartRunning ? 'Categorizing...' : 'Smart Categorize'}
            </button>
            <Link href="/accounting/bank-transactions/new"
              className={`${PILL} border-teal-500/60 text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 hover:border-teal-400 font-medium`}>
              <Plus className="h-3.5 w-3.5" /> New Transaction
            </Link>
            <BankTxMoreMenu selectedBank={selectedBank} onExport={p.onExport} onExportAll={p.onExportAll} onDownloadReport={p.onDownloadReport} />
          </>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />
            <input
              type="text"
              placeholder="Search..."
              aria-label="Search transactions"
              value={searchTerm}
              onChange={e => onSearchChange(e.target.value)}
              className="pl-7 pr-3 py-1 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] w-44"
            />
          </div>
          <BankTxStatusSelect tab={tab} allocationFilter={p.allocationFilter} reconFilter={p.reconFilter}
            onAllocationFilterChange={p.onAllocationFilterChange} onReconFilterChange={p.onReconFilterChange} />
          <button type="button" onClick={panel.toggle} aria-expanded={panel.open} aria-controls="bank-tx-filter-panel"
            className={`${PILL} border-[var(--ff-border-light)] ${folded > 0 ? 'text-teal-700 dark:text-teal-400' : 'text-[var(--ff-text-secondary)]'} hover:text-[var(--ff-text-primary)]`}>
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />{folded > 0 ? `Filters (${folded})` : 'Filters'}
          </button>
          {/* Column visibility toggles */}
          <button type="button" onClick={onToggleCC} title="Toggle Cost Centre columns" aria-pressed={showCC} className={toggleClass(showCC)}>CC</button>
          <button type="button" onClick={onToggleBU} title="Toggle Business Unit column" aria-pressed={showBU} className={toggleClass(showBU)}>BU</button>
          <span className="text-xs text-[var(--ff-text-tertiary)]">
            {total > 0 ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}` : '0'} of {total}
          </span>
        </div>
      </div>

      {panel.open && (
        <div id="bank-tx-filter-panel" className="mt-1.5 flex flex-wrap items-end gap-2 text-xs text-[var(--ff-text-secondary)]">
          <div className="w-40"><DateField label="From date" value={fromDate || null} onChange={(iso, v) => { if (v.valid) onFromDateChange(iso ?? ''); }} /></div>
          <div className="w-40"><DateField label="To date" value={toDate || null} onChange={(iso, v) => { if (v.valid) onToDateChange(iso ?? ''); }} /></div>
          <div className="flex items-center gap-1 pb-1">
            <DebouncedAmountInput key={`min-${resetKey ?? 0}`} id="bank-tx-min-amount" label="Min R" value={fromAmount} placeholder="0" onCommit={onFromAmountChange} />
            <DebouncedAmountInput key={`max-${resetKey ?? 0}`} id="bank-tx-max-amount" label="Max R" value={toAmount} placeholder="any" onCommit={onToAmountChange} />
          </div>
          <div className="flex flex-wrap items-center gap-2 pb-1">
            <BankTxFilterSelects sortOrder={sortOrder} txType={txType} allocType={allocType} hasSuggestion={hasSuggestion}
              onSortOrderChange={p.onSortOrderChange} onTxTypeChange={p.onTxTypeChange} onAllocTypeChange={p.onAllocTypeChange}
              onHasSuggestionChange={p.onHasSuggestionChange} />
          </div>
        </div>
      )}
    </div>
  );
}
