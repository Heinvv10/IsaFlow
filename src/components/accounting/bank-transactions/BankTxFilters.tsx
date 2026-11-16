/**
 * BankTxFilters — Full toolbar: date range, amount range, sort, allocation/type/category
 * filters, column visibility toggles, search, and action buttons (Import/Export/Smart Categorize etc.)
 */

import Link from 'next/link';
import {
  Loader2, RefreshCw, CheckCheck, Upload, Search, Trash2, Layers, Zap, Plus, FileText,
} from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { BankTxExportButtons } from './BankTxExportButtons';
import { DebouncedAmountInput } from './DebouncedAmountInput';
import { BankTxFilterSelects } from './BankTxFilterSelects';
import type { ReconFilter } from '@/modules/accounting/services/bank/bankTxTabCond';

type Tab = import('./BankTxTabs').BankTxTab;

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
}

export function BankTxFilters({
  tab, page, total, pageSize, selectedCount, selectedBank, smartRunning, busy, progress,
  showCC, showBU,
  searchTerm, fromDate, toDate, fromAmount, toAmount,
  sortOrder, allocationFilter, txType, allocType, hasSuggestion, reconFilter,
  onRefresh, onBulkAccept, onBatchAccept, onBatchDelete, onToggleBatchEdit,
  onExport, onExportAll, onApplyRules, onDownloadReport,
  onSearchChange, onFromDateChange, onToDateChange, onFromAmountChange, onToAmountChange,
  onSortOrderChange, onAllocationFilterChange, onTxTypeChange, onAllocTypeChange,
  onHasSuggestionChange, onReconFilterChange, onToggleCC, onToggleBU,
}: BankTxFiltersProps) {
  return (
    <div className="px-6 py-2 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]/30 flex items-center gap-2 flex-wrap">
      <button
        onClick={onRefresh}
        title="Refresh"
        className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
      >
        <RefreshCw className="h-3.5 w-3.5" /> Actions
      </button>

      {tab === 'new' && (
        <>
          <button
            onClick={onBulkAccept}
            disabled={selectedCount === 0 || busy?.has('review')}
            aria-busy={busy?.has('review') || undefined}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30"
          >
            {busy?.has('review') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />} Mark as Reviewed
          </button>
          {selectedCount > 0 && (
            <button
              onClick={onBatchAccept}
              disabled={busy?.has('batch-allocate')}
              aria-busy={busy?.has('batch-allocate') || undefined}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-teal-400 hover:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 disabled:opacity-60"
            >
              {busy?.has('batch-allocate') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
              {progress?.key === 'batch-allocate' ? ` Allocating ${progress.done + 1} of ${progress.total}` : ' Batch Allocate'}
            </button>
          )}
          <button
            onClick={onBatchDelete}
            disabled={selectedCount === 0 || busy?.has('delete')}
            aria-busy={busy?.has('delete') || undefined}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30"
          >
            {busy?.has('delete') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
          </button>
          <button
            onClick={onToggleBatchEdit}
            disabled={selectedCount === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30"
          >
            <Layers className="h-3.5 w-3.5" /> Batch Edit
          </button>
        </>
      )}

      <div className="border-l border-[var(--ff-border-light)] h-5 mx-1" />

      <Link
        href="/accounting/bank-reconciliation/import"
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
      >
        <Upload className="h-3.5 w-3.5" /> Import Bank Statements
      </Link>
      <BankTxExportButtons onExport={onExport} onExportAll={onExportAll} />
      <button
        onClick={onApplyRules}
        disabled={!selectedBank || smartRunning || busy?.has('apply-rules')}
        title="Apply bank rules, then smart-categorize remaining transactions using patterns and historical data"
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-yellow-500/40 text-xs text-yellow-500 hover:text-yellow-400 hover:border-yellow-400 disabled:opacity-30"
      >
        {smartRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
        {smartRunning ? 'Categorizing...' : 'Smart Categorize'}
      </button>
      <Link
        href="/accounting/bank-transactions/new"
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-teal-500/60 text-xs text-teal-400 hover:text-teal-300 hover:border-teal-400 font-medium"
      >
        <Plus className="h-3.5 w-3.5" /> New Transaction
      </Link>
      <button
        onClick={onDownloadReport}
        disabled={!selectedBank}
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30"
      >
        <FileText className="h-3.5 w-3.5" /> Recon Report
      </button>

      {/* Date range filter */}
      <div className="flex items-start gap-1 text-xs text-[var(--ff-text-secondary)]">
        <div className="w-40"><DateField label="From date" value={fromDate || null} onChange={(iso, v) => { if (v.valid) onFromDateChange(iso ?? ''); }} /></div>
        <div className="w-40"><DateField label="To date" value={toDate || null} onChange={(iso, v) => { if (v.valid) onToDateChange(iso ?? ''); }} /></div>
      </div>

      {/* Amount range filter */}
      <div className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
        <DebouncedAmountInput id="bank-tx-min-amount" label="Min R" value={fromAmount} placeholder="0" onCommit={onFromAmountChange} />
        <DebouncedAmountInput id="bank-tx-max-amount" label="Max R" value={toAmount} placeholder="any" onCommit={onToAmountChange} />
      </div>

      <div className="border-l border-[var(--ff-border-light)] h-5 mx-1" />

      <BankTxFilterSelects
        tab={tab} sortOrder={sortOrder} allocationFilter={allocationFilter} txType={txType} allocType={allocType} hasSuggestion={hasSuggestion}
        reconFilter={reconFilter} onReconFilterChange={onReconFilterChange}
        onSortOrderChange={onSortOrderChange} onAllocationFilterChange={onAllocationFilterChange} onTxTypeChange={onTxTypeChange}
        onAllocTypeChange={onAllocTypeChange} onHasSuggestionChange={onHasSuggestionChange}
      />

      {/* Column visibility toggles */}
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleCC}
          title="Toggle Cost Centre columns"
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            showCC
              ? 'bg-blue-500/20 text-blue-400'
              : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] border border-[var(--ff-border-light)]'
          }`}
        >
          CC
        </button>
        <button
          onClick={onToggleBU}
          title="Toggle Business Unit column"
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            showBU
              ? 'bg-blue-500/20 text-blue-400'
              : 'bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] border border-[var(--ff-border-light)]'
          }`}
        >
          BU
        </button>
      </div>

      {/* Search + record count */}
      <div className="ml-auto flex items-center gap-2">
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
        <span className="text-xs text-[var(--ff-text-tertiary)]">
          {total > 0 ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}` : '0'} of {total}
        </span>
      </div>
    </div>
  );
}
