/**
 * BankTxFilters — Full toolbar: date range, amount range, sort, allocation/type/category
 * filters, column visibility toggles, search, and action buttons (Import/Export/Smart Categorize etc.)
 */

import { useRef } from 'react';
import Link from 'next/link';
import {
  Loader2, RefreshCw, CheckCheck, Upload, Download, Search, Trash2, Layers, Zap, Plus, FileText,
} from 'lucide-react';

type Tab = 'new' | 'reviewed' | 'excluded';

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
  allocationFilter: 'all' | 'unallocated' | 'allocated';
  txType: 'all' | 'spent' | 'received';
  allocType: 'all' | 'account' | 'supplier' | 'customer';
  hasSuggestion: 'all' | 'yes' | 'no';
  onRefresh: () => void;
  onBulkAccept: () => void;
  onBatchAccept: () => void;
  onBatchDelete: () => void;
  onToggleBatchEdit: () => void;
  onExport: () => void;
  onApplyRules: () => void;
  onDownloadReport: () => void;
  onSearchChange: (v: string) => void;
  onFromDateChange: (v: string) => void;
  onToDateChange: (v: string) => void;
  onFromAmountChange: (v: string) => void;
  onToAmountChange: (v: string) => void;
  onSortOrderChange: (v: 'asc' | 'desc') => void;
  onAllocationFilterChange: (v: 'all' | 'unallocated' | 'allocated') => void;
  onTxTypeChange: (v: 'all' | 'spent' | 'received') => void;
  onAllocTypeChange: (v: 'all' | 'account' | 'supplier' | 'customer') => void;
  onHasSuggestionChange: (v: 'all' | 'yes' | 'no') => void;
  onToggleCC: () => void;
  onToggleBU: () => void;
}

export function BankTxFilters({
  tab, page, total, pageSize, selectedCount, selectedBank, smartRunning,
  showCC, showBU, showBatchEdit,
  searchTerm, fromDate, toDate, fromAmount, toAmount,
  sortOrder, allocationFilter, txType, allocType, hasSuggestion,
  onRefresh, onBulkAccept, onBatchAccept, onBatchDelete, onToggleBatchEdit,
  onExport, onApplyRules, onDownloadReport,
  onSearchChange, onFromDateChange, onToDateChange, onFromAmountChange, onToAmountChange,
  onSortOrderChange, onAllocationFilterChange, onTxTypeChange, onAllocTypeChange,
  onHasSuggestionChange, onToggleCC, onToggleBU,
}: BankTxFiltersProps) {
  const amountDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            disabled={selectedCount === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30"
          >
            <CheckCheck className="h-3.5 w-3.5" /> Mark as Reviewed
          </button>
          {selectedCount > 0 && (
            <button
              onClick={onBatchAccept}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-teal-400 hover:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Batch Allocate
            </button>
          )}
          <button
            onClick={onBatchDelete}
            disabled={selectedCount === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
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
      <button
        onClick={onExport}
        className="flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
      >
        <Download className="h-3.5 w-3.5" /> Export
      </button>
      <button
        onClick={onApplyRules}
        disabled={!selectedBank || smartRunning}
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
      <div className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
        <input
          type="date"
          value={fromDate}
          onChange={e => onFromDateChange(e.target.value)}
          className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
        />
        <span>to</span>
        <input
          type="date"
          value={toDate}
          onChange={e => onToDateChange(e.target.value)}
          className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
        />
      </div>

      {/* Amount range filter */}
      <div className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
        <span className="shrink-0">Min R</span>
        <input
          type="number"
          step="0.01"
          value={fromAmount}
          onChange={e => {
            onFromAmountChange(e.target.value);
            if (amountDebounceTimer.current) clearTimeout(amountDebounceTimer.current);
            amountDebounceTimer.current = setTimeout(() => {}, 500);
          }}
          placeholder="0"
          className="w-20 px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
        />
        <span className="shrink-0">Max R</span>
        <input
          type="number"
          step="0.01"
          value={toAmount}
          onChange={e => {
            onToAmountChange(e.target.value);
            if (amountDebounceTimer.current) clearTimeout(amountDebounceTimer.current);
            amountDebounceTimer.current = setTimeout(() => {}, 500);
          }}
          placeholder="any"
          className="w-20 px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
        />
      </div>

      <div className="border-l border-[var(--ff-border-light)] h-5 mx-1" />

      <select
        value={sortOrder}
        onChange={e => onSortOrderChange(e.target.value as 'asc' | 'desc')}
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="desc">Newest First</option>
        <option value="asc">Oldest First</option>
      </select>

      {tab === 'new' && (
        <select
          value={allocationFilter}
          onChange={e => onAllocationFilterChange(e.target.value as 'all' | 'unallocated' | 'allocated')}
          className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
        >
          <option value="all">All Status</option>
          <option value="unallocated">Unallocated</option>
          <option value="allocated">Allocated</option>
        </select>
      )}

      <select
        value={txType}
        onChange={e => onTxTypeChange(e.target.value as 'all' | 'spent' | 'received')}
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="all">All Types</option>
        <option value="spent">Spent</option>
        <option value="received">Received</option>
      </select>

      <select
        value={allocType}
        onChange={e => onAllocTypeChange(e.target.value as 'all' | 'account' | 'supplier' | 'customer')}
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="all">All Categories</option>
        <option value="account">Account</option>
        <option value="supplier">Supplier</option>
        <option value="customer">Customer</option>
      </select>

      <select
        value={hasSuggestion}
        onChange={e => onHasSuggestionChange(e.target.value as 'all' | 'yes' | 'no')}
        className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
      >
        <option value="all">All Suggestions</option>
        <option value="yes">Has Suggestion</option>
        <option value="no">No Suggestion</option>
      </select>

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
