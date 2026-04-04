/**
 * Bank Transactions — Sage "Process Bank" equivalent.
 * Thin shell: state, data fetching, layout composition.
 * Action handlers: useBankTxActions | Ref data: useBankTxRefData
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  BankTxTable,
  type AllocType, type BankTx, type SelectOption, type RowSelection,
} from '@/components/accounting/BankTxTable';
import { BankTxBankCards, type BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';
import { BankTxFilters } from '@/components/accounting/bank-transactions/BankTxFilters';
import { BankTxBatchPanel, type RulePrompt } from '@/components/accounting/bank-transactions/BankTxBatchPanel';
import { BankTxModals } from '@/components/accounting/bank-transactions/BankTxModals';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';
import { Loader2, AlertCircle } from 'lucide-react';

type Tab = 'new' | 'reviewed' | 'excluded';
const PAGE_SIZE = 25;

function tabToStatus(tab: Tab): string {
  if (tab === 'new') return 'imported';
  if (tab === 'excluded') return 'excluded';
  return 'matched';
}

export default function BankTransactionsPage() {
  // Reference / lookup data
  const [glAccounts, setGlAccounts] = useState<SelectOption[]>([]);
  const [suppliers, setSuppliers] = useState<SelectOption[]>([]);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [cc1Options, setCc1Options] = useState<SelectOption[]>([]);
  const [cc2Options, setCc2Options] = useState<SelectOption[]>([]);
  const [buOptions, setBuOptions] = useState<SelectOption[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAcct[]>([]);
  const [selectedBank, setSelectedBank] = useState('');
  useBankTxRefData({ setBankAccounts, setGlAccounts, setSuppliers, setCustomers, setCc1Options, setCc2Options, setBuOptions, setSelectedBank });
  // Transaction list
  const [transactions, setTransactions] = useState<BankTx[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  // Filter / pagination
  const [tab, setTab] = useState<Tab>('new');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [fromAmount, setFromAmount] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [allocationFilter, setAllocationFilter] = useState<'all' | 'unallocated' | 'allocated'>('all');
  const [txType, setTxType] = useState<'all' | 'spent' | 'received'>('all');
  const [allocType, setAllocType] = useState<'all' | 'account' | 'supplier' | 'customer'>('all');
  const [hasSuggestion, setHasSuggestion] = useState<'all' | 'yes' | 'no'>('all');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Selection / UI
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rowSelections, setRowSelections] = useState<Record<string, RowSelection>>({});
  const [smartRunning, setSmartRunning] = useState(false);
  const [showBatchEdit, setShowBatchEdit] = useState(false);
  const [batchType, setBatchType] = useState<AllocType>('account');
  const [batchSearch, setBatchSearch] = useState('');
  const [showCC, setShowCC] = useState(false);
  const [showBU, setShowBU] = useState(false);
  // Modal triggers
  const [splitTxId, setSplitTxId] = useState<string | null>(null);
  const [excludingTxId, setExcludingTxId] = useState<string | null>(null);
  const [findMatchTxId, setFindMatchTxId] = useState<string | null>(null);
  const [attachmentsTxId, setAttachmentsTxId] = useState<string | null>(null);
  const [createRuleTx, setCreateRuleTx] = useState<BankTx | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [createEntityTxId, setCreateEntityTxId] = useState<string | null>(null);
  const [createEntityType, setCreateEntityType] = useState<AllocType | null>(null);
  // Column visibility — company settings + localStorage override
  useEffect(() => {
    Promise.all([
      apiFetch('/api/accounting/accounting-settings?key=enable_cost_centres').then(r => r.json()),
      apiFetch('/api/accounting/accounting-settings?key=enable_business_units').then(r => r.json()),
    ]).then(([ccJson, buJson]) => {
      const ccLocal = localStorage.getItem('isaflow_bank_showCC');
      const buLocal = localStorage.getItem('isaflow_bank_showBU');
      setShowCC(ccLocal !== null ? ccLocal !== 'false' : ccJson.data?.value === 'true');
      setShowBU(buLocal !== null ? buLocal !== 'false' : buJson.data?.value === 'true');
    }).catch(() => { /* defaults */ });
  }, []);
  // Debounce search — 500ms
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { setDebouncedSearch(searchTerm); setPage(1); }, 500);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchTerm]);
  // Load transactions
  const loadTransactions = useCallback(async () => {
    if (!selectedBank) return;
    setIsLoading(true); setError('');
    try {
      const params = new URLSearchParams({ bank_account_id: selectedBank, status: tabToStatus(tab), limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      if (fromDate) params.set('from_date', fromDate);
      if (toDate) params.set('to_date', toDate);
      if (fromAmount) params.set('from_amount', fromAmount);
      if (toAmount) params.set('to_amount', toAmount);
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (sortOrder !== 'desc') params.set('sort_order', sortOrder);
      if (allocationFilter !== 'all') params.set('allocation_filter', allocationFilter);
      if (txType !== 'all') params.set('tx_type', txType);
      if (allocType !== 'all') params.set('alloc_type', allocType);
      if (hasSuggestion !== 'all') params.set('has_suggestion', hasSuggestion);
      const res = await apiFetch(`/api/accounting/bank-transactions?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setTransactions(data.transactions || []); setTotal(data.total || 0);
    } catch { setError('Failed to load transactions'); }
    finally { setIsLoading(false); }
  }, [selectedBank, tab, page, fromDate, toDate, fromAmount, toAmount, debouncedSearch, sortOrder, allocationFilter, txType, allocType, hasSuggestion]);

  useEffect(() => { loadTransactions(); }, [loadTransactions]);

  // ---- Seed rowSelections from DB suggestion fields ----
  useEffect(() => {
    if (transactions.length === 0) return;
    const initial: Record<string, RowSelection> = {};
    for (const tx of transactions) {
      if (rowSelections[tx.id]?.entityId) continue;
      const dim = { cc1Id: tx.cc1Id, cc2Id: tx.cc2Id, buId: tx.buId };
      if (tx.suggestedSupplierId) {
        initial[tx.id] = { type: 'supplier', entityId: tx.suggestedSupplierId, label: tx.suggestedSupplierName || tx.suggestedCategory || '', vatCode: 'none', ...dim };
      } else if (tx.suggestedClientId) {
        initial[tx.id] = { type: 'customer', entityId: tx.suggestedClientId, label: tx.suggestedClientName || tx.suggestedCategory || '', vatCode: 'none', ...dim };
      } else if (tx.suggestedGlAccountId) {
        initial[tx.id] = { type: 'account', entityId: tx.suggestedGlAccountId, vatCode: (tx.suggestedVatCode || 'none') as RowSelection['vatCode'], ...dim,
          label: tx.suggestedGlAccountCode ? `${tx.suggestedGlAccountCode} ${tx.suggestedGlAccountName || ''}` : tx.suggestedGlAccountName || tx.suggestedCategory || '' };
      }
    }
    if (Object.keys(initial).length > 0) {
      setRowSelections(prev => {
        const merged = { ...prev };
        for (const [id, sel] of Object.entries(initial)) { if (!merged[id]?.entityId) merged[id] = sel; }
        return merged;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);

  // ---- Reset filters when bank or tab changes ----
  useEffect(() => {
    setPage(1); setSelectedIds(new Set()); setRowSelections({});
    setAllocationFilter('all'); setTxType('all'); setAllocType('all'); setHasSuggestion('all');
  }, [selectedBank, tab]);

  // ---- Build action handlers ----
  const actions = buildBankTxActions({
    transactions, glAccounts, selectedBank, selectedIds, rowSelections, batchType,
    excludingTxId, createEntityTxId,
    setSmartRunning, setRowSelections, setTransactions, setSelectedIds, setShowBatchEdit,
    setRulePrompt, setExcludingTxId, loadTransactions,
  });

  const bank = bankAccounts.find(b => b.id === selectedBank);
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const allSelected = transactions.length > 0 && transactions.every(t => selectedIds.has(t.id));
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Wrap a state setter so it always resets pagination to page 1
  function withReset<T>(fn: (v: T) => void) { return (v: T) => { fn(v); setPage(1); }; }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <BankTxBankCards bankAccounts={bankAccounts} selectedBank={selectedBank} tab={tab} total={total} onSelectBank={setSelectedBank} />

        {/* Tabs */}
        <div className="px-6 border-b border-[var(--ff-border-light)]">
          <div className="flex gap-0">
            {(['new', 'reviewed', 'excluded'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t ? (t === 'excluded' ? 'border-red-500 text-red-400' : 'border-teal-500 text-teal-400') : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
                {t === 'new' ? 'New Transactions' : t === 'excluded' ? 'Excluded' : 'Reviewed Transactions'}
              </button>
            ))}
          </div>
        </div>

        <BankTxFilters
          tab={tab} page={page} total={total} pageSize={PAGE_SIZE} selectedCount={selectedIds.size}
          selectedBank={selectedBank} smartRunning={smartRunning} showCC={showCC} showBU={showBU}
          showBatchEdit={showBatchEdit} searchTerm={searchTerm} fromDate={fromDate} toDate={toDate}
          fromAmount={fromAmount} toAmount={toAmount} sortOrder={sortOrder}
          allocationFilter={allocationFilter} txType={txType} allocType={allocType} hasSuggestion={hasSuggestion}
          onRefresh={loadTransactions} onBulkAccept={actions.handleBulkAccept}
          onBatchAccept={actions.handleBatchAccept} onBatchDelete={actions.handleBatchDelete}
          onToggleBatchEdit={() => { setShowBatchEdit(s => !s); setBatchSearch(''); }}
          onExport={() => actions.handleExport(bank?.accountCode)}
          onApplyRules={actions.handleApplyRules}
          onDownloadReport={() => actions.handleDownloadReport(bank?.accountCode)}
          onSearchChange={setSearchTerm}
          onFromDateChange={withReset(setFromDate)} onToDateChange={withReset(setToDate)}
          onFromAmountChange={withReset(setFromAmount)} onToAmountChange={withReset(setToAmount)}
          onSortOrderChange={withReset(setSortOrder)} onAllocationFilterChange={withReset(setAllocationFilter)}
          onTxTypeChange={withReset(setTxType)} onAllocTypeChange={withReset(setAllocType)}
          onHasSuggestionChange={withReset(setHasSuggestion)}
          onToggleCC={() => { const v = !showCC; setShowCC(v); localStorage.setItem('isaflow_bank_showCC', String(v)); }}
          onToggleBU={() => { const v = !showBU; setShowBU(v); localStorage.setItem('isaflow_bank_showBU', String(v)); }}
        />

        <BankTxBatchPanel
          showBatchEdit={showBatchEdit} selectedCount={selectedIds.size} batchType={batchType}
          batchSearch={batchSearch} glAccounts={glAccounts} suppliers={suppliers} customers={customers}
          rulePrompt={rulePrompt}
          onBatchTypeChange={t => { setBatchType(t); setBatchSearch(''); }}
          onBatchSearchChange={setBatchSearch} onApplyBatchEdit={actions.handleApplyBatchEdit}
          onCancelBatchEdit={() => setShowBatchEdit(false)}
          onCreateRule={tx => { setCreateRuleTx(tx); setRulePrompt(null); }}
          onDismissRulePrompt={() => setRulePrompt(null)}
        />

        {/* Table */}
        <div className="px-4 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-blue-500" /></div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
          ) : transactions.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No {tab === 'new' ? 'new' : tab === 'excluded' ? 'excluded' : 'reviewed'} transactions for this account
            </div>
          ) : (
            <BankTxTable
              transactions={transactions} glAccounts={glAccounts} suppliers={suppliers}
              customers={customers} cc1Options={cc1Options} cc2Options={cc2Options} buOptions={buOptions}
              showCC={showCC} showBU={showBU} selectedIds={selectedIds} rowSelections={rowSelections}
              allSelected={allSelected} tab={tab}
              onToggleSelect={toggleSelect}
              onSelectAll={() => setSelectedIds(allSelected ? new Set() : new Set(transactions.map(t => t.id)))}
              onRowTypeChange={actions.handleRowTypeChange} onRowEntityChange={actions.handleRowEntityChange}
              onRowVatChange={actions.handleRowVatChange} onRowDimensionChange={actions.handleRowDimensionChange}
              onAccept={actions.handleAccept} onExclude={actions.handleExclude}
              onUnmatch={actions.handleUnmatch} onSplit={id => setSplitTxId(id)}
              onUpdateNotes={actions.handleUpdateNotes} onFindMatch={id => setFindMatchTxId(id)}
              onReverse={actions.handleReverse} onAttachments={id => setAttachmentsTxId(id)}
              onCreateRule={tx => setCreateRuleTx(tx)}
              onCreateEntity={(txId, type) => { setCreateEntityTxId(txId); setCreateEntityType(type); }}
            />
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-3 border-t border-[var(--ff-border-light)] flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button disabled={page <= 1} onClick={() => setPage(1)} className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">First</button>
              {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
                const p = totalPages <= 10 ? i + 1 : page <= 5 ? i + 1 : page >= totalPages - 4 ? totalPages - 9 + i : page - 5 + i;
                return (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-7 h-7 rounded text-xs ${p === page ? 'bg-teal-600 text-white font-bold' : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'}`}>
                    {p}
                  </button>
                );
              })}
              <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">Last</button>
            </div>
            <span className="text-xs text-[var(--ff-text-tertiary)]">Displaying {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}</span>
          </div>
        )}

        {/* Bottom bar */}
        {tab === 'new' && transactions.length > 0 && (
          <div className="sticky bottom-0 bg-[var(--ff-bg-secondary)] border-t border-[var(--ff-border-light)] px-6 py-3 flex items-center justify-center">
            <button onClick={actions.handleBulkAccept} disabled={selectedIds.size === 0}
              className="px-5 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              Mark Selected as Reviewed ({selectedIds.size})
            </button>
          </div>
        )}
      </div>

      <BankTxModals
        transactions={transactions} glAccounts={glAccounts} suppliers={suppliers} customers={customers}
        selectedBank={selectedBank} rowSelections={rowSelections} splitTxId={splitTxId}
        excludingTxId={excludingTxId} findMatchTxId={findMatchTxId} attachmentsTxId={attachmentsTxId}
        createRuleTx={createRuleTx} createEntityTxId={createEntityTxId} createEntityType={createEntityType}
        onSplitClose={() => setSplitTxId(null)} onSplitDone={() => { setSplitTxId(null); loadTransactions(); }}
        onExcludeClose={() => setExcludingTxId(null)} onExcludeConfirm={actions.handleExcludeConfirm}
        onFindMatchClose={() => setFindMatchTxId(null)} onFindMatchDone={() => { setFindMatchTxId(null); loadTransactions(); }}
        onAttachmentsClose={() => setAttachmentsTxId(null)} onCreateRuleClose={() => setCreateRuleTx(null)}
        onCreateRuleDone={() => { setCreateRuleTx(null); setRowSelections(() => ({})); loadTransactions(); }}
        onCreateEntityClose={() => { setCreateEntityTxId(null); setCreateEntityType(null); }}
        onCreateEntityDone={(entity, type) => { actions.handleCreateEntityDone(entity, type, setGlAccounts, setSuppliers, setCustomers); setCreateEntityTxId(null); setCreateEntityType(null); }}
      />
    </AppLayout>
  );
}
