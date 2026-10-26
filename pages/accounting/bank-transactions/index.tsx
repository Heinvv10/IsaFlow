/**
 * Bank Transactions — Sage "Process Bank" equivalent.
 * Thin shell: state, data fetching, layout composition.
 * Action handlers: useBankTxActions | Ref data: useBankTxRefData
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  BankTxTable,
  type AllocType, type BankTx, type SelectOption, type RowSelection,
} from '@/components/accounting/BankTxTable';
import { BankTxBankCards, type BankAcct } from '@/components/accounting/bank-transactions/BankTxBankCards';
import { BankTxFilters } from '@/components/accounting/bank-transactions/BankTxFilters';
import { BankTxBatchPanel, type RulePrompt } from '@/components/accounting/bank-transactions/BankTxBatchPanel';
import { BankTxModals } from '@/components/accounting/bank-transactions/BankTxModals';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { useRelinkTransfers } from '@/components/accounting/bank-transactions/useRelinkTransfers';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';
import { BankTxSuppliersNotice, type SuppliersStatus } from '@/components/accounting/bank-transactions/BankTxSuppliersNotice';
import { BankEmptyState } from '@/components/accounting/banking/BankEmptyState';
import { AutoPostRunsPanel } from '@/components/accounting/bank-transactions/AutoPostRunsPanel';
import { CodingMetricsStrip } from '@/components/accounting/bank-transactions/CodingMetricsStrip';
import { actionableIds } from '@/components/accounting/bank-transactions/pendingFeedRow';
import { BankTxPagination, BankTxReviewBar } from '@/components/accounting/bank-transactions/BankTxPagination';
import { BankTxTabs, type BankTxTab as Tab } from '@/components/accounting/bank-transactions/BankTxTabs';
import { useLlmResultPoll } from '@/components/accounting/bank-transactions/useLlmResultPoll';
import { suggestedRowSelections } from '@/components/accounting/bank-transactions/suggestedRowSelections';
import { bankTxQueryParams } from '@/components/accounting/bank-transactions/bankTxQuery';
import { BankTxListFrame } from '@/components/accounting/bank-transactions/BankTxListFrame';

const PAGE_SIZE = 25;

export default function BankTransactionsPage() {
  const router = useRouter();
  // Reference / lookup data
  const [glAccounts, setGlAccounts] = useState<SelectOption[]>([]);
  const [suppliers, setSuppliers] = useState<SelectOption[]>([]);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [cc1Options, setCc1Options] = useState<SelectOption[]>([]);
  const [cc2Options, setCc2Options] = useState<SelectOption[]>([]);
  const [buOptions, setBuOptions] = useState<SelectOption[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAcct[]>([]);
  const [selectedBank, setSelectedBank] = useState('');
  const [refDataLoaded, setRefDataLoaded] = useState(false);
  const [suppliersStatus, setSuppliersStatus] = useState<SuppliersStatus>('loading');
  const didApplyQueryParam = useRef(false);
  const { refreshBankAccounts } = useBankTxRefData({ setBankAccounts, setGlAccounts, setSuppliers, setCustomers, setCc1Options, setCc2Options, setBuOptions, setSelectedBank, setRefDataLoaded, setSuppliersStatus });

  // Pre-select bank account from query param (e.g. ?account_id=...)
  useEffect(() => {
    if (didApplyQueryParam.current) return;
    const accountId = router.query.account_id as string | undefined;
    if (!accountId || bankAccounts.length === 0) return;
    const match = bankAccounts.find(b => b.id === accountId);
    if (match) {
      setSelectedBank(accountId);
      didApplyQueryParam.current = true;
    }
  }, [router.query.account_id, bankAccounts]);
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
  const [allocationFilter, setAllocationFilter] = useState<'all' | 'unallocated' | 'suggested' | 'allocated'>('all');
  const [txType, setTxType] = useState<'all' | 'spent' | 'received'>('all');
  const [allocType, setAllocType] = useState<'all' | 'account' | 'supplier' | 'customer' | 'transfer'>('all');
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
  const [queryTx, setQueryTx] = useState<BankTx | null>(null);
  const [linkTx, setLinkTx] = useState<BankTx | null>(null);
  const [createRuleTx, setCreateRuleTx] = useState<BankTx | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [createEntityTxId, setCreateEntityTxId] = useState<string | null>(null);
  const [createEntityType, setCreateEntityType] = useState<AllocType | null>(null);
  // Column visibility — company settings + localStorage override
  useEffect(() => {
    const readSetting = (key: string) => apiFetch(`/api/accounting/accounting-settings?key=${key}`).then(async r => { await assertOk(r, 'Could not load the column settings'); return r.json(); });
    Promise.all([readSetting('enable_cost_centres'), readSetting('enable_business_units')]).then(([ccJson, buJson]) => {
      const ccLocal = localStorage.getItem('isaflow_bank_showCC');
      const buLocal = localStorage.getItem('isaflow_bank_showBU');
      setShowCC(ccLocal !== null ? ccLocal !== 'false' : ccJson.data?.value === 'true');
      setShowBU(buLocal !== null ? buLocal !== 'false' : buJson.data?.value === 'true');
    }).catch(err => log.warn('Column settings unavailable, using defaults', { error: err }, 'bank-transactions'));
  }, []);
  // Debounce search — 500ms
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { setDebouncedSearch(searchTerm); setPage(1); }, 500);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchTerm]);
  // Load transactions
  const loadTransactions = useCallback(async () => {
    if (!selectedBank) { setIsLoading(false); setTransactions([]); setTotal(0); return; }
    setIsLoading(true); setError('');
    try {
      const params = bankTxQueryParams({ bankAccountId: selectedBank, tab, page, pageSize: PAGE_SIZE, fromDate, toDate, fromAmount, toAmount,
        search: debouncedSearch, sortOrder, allocationFilter, txType, allocType, hasSuggestion });
      const res = await apiFetch(`/api/accounting/bank-transactions?${params}`); await assertOk(res, 'Could not load transactions - try again');
      const json = await res.json();
      const data = json.data || json;
      setTransactions(data.transactions || []); setTotal(data.total || 0);
    } catch (err) { setTransactions([]); setTotal(0); setError(apiErrorMessage(err, 'Could not load transactions - try again')); }
    finally { setIsLoading(false); }
  }, [selectedBank, tab, page, fromDate, toDate, fromAmount, toAmount, debouncedSearch, sortOrder, allocationFilter, txType, allocType, hasSuggestion]);

  useEffect(() => { void loadTransactions(); }, [loadTransactions]);

  // AI background poll — picks up late-arriving LLM suggestions after smart-categorize
  const { aiPolling, pollForLlmResults } = useLlmResultPoll(transactions, loadTransactions);

  const relinkFailed = useRelinkTransfers(selectedBank);

  // ---- Seed rowSelections from DB suggestion fields ----
  useEffect(() => {
    if (transactions.length === 0) return;
    const initial = suggestedRowSelections(transactions, rowSelections);
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
    setRulePrompt, setExcludingTxId, loadTransactions, refreshBankAccounts,
    onLlmResidual: pollForLlmResults,
  });

  const bank = bankAccounts.find(b => b.id === selectedBank);
  // Transfer targets — every other bank GL account (source bank excluded).
  // Sub-accounts carry their group name so 20+ paycards stay scannable.
  const transferTargets: SelectOption[] = bankAccounts
    .filter(b => b.id !== selectedBank)
    .map(b => ({ id: b.id, code: b.accountCode, name: b.groupName ? `${b.groupName} › ${b.accountName}` : b.accountName }));
  // Pending rows are read-only — select-all only ever selects the actionable
  // (non-pending) rows, so "all selected" is judged against that subset too.
  const selectableTxIds = actionableIds(transactions, transactions.map(t => t.id));
  const allSelected = selectableTxIds.length > 0 && selectableTxIds.every(id => selectedIds.has(id));
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Wrap a state setter so it always resets pagination to page 1
  function withReset<T>(fn: (v: T) => void) { return (v: T) => { fn(v); setPage(1); }; }

  const noBankAccounts = refDataLoaded && bankAccounts.length === 0;

  if (noBankAccounts) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)]">
          <h1 className="sr-only">Bank Transactions</h1>
          <BankEmptyState context="bank-transactions" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <BankTxBankCards bankAccounts={bankAccounts} selectedBank={selectedBank} tab={tab} total={total} onSelectBank={setSelectedBank} onAccountsChanged={refreshBankAccounts} />

        <BankTxTabs tab={tab} onTab={setTab} />

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

        <BankTxSuppliersNotice status={suppliersStatus} />

        <BankTxBatchPanel
          showBatchEdit={showBatchEdit} selectedCount={selectedIds.size} batchType={batchType}
          batchSearch={batchSearch} glAccounts={glAccounts} suppliers={suppliers} suppliersLoading={suppliersStatus === 'loading'} customers={customers}
          transferTargets={transferTargets}
          rulePrompt={rulePrompt}
          onBatchTypeChange={t => { setBatchType(t); setBatchSearch(''); }}
          onBatchSearchChange={setBatchSearch} onApplyBatchEdit={actions.handleApplyBatchEdit}
          onCancelBatchEdit={() => setShowBatchEdit(false)}
          onCreateRule={tx => { setCreateRuleTx(tx); setRulePrompt(null); }}
          onDismissRulePrompt={() => setRulePrompt(null)}
        />

        {/* Table */}
        <div className="px-4 py-2">
          <CodingMetricsStrip />
          <AutoPostRunsPanel onUndone={loadTransactions} />
          <BankTxListFrame relinkFailed={relinkFailed} aiPolling={aiPolling} isLoading={isLoading} error={error}
            empty={transactions.length === 0} tab={tab}>
            <BankTxTable
              transactions={transactions} glAccounts={glAccounts} suppliers={suppliers} suppliersLoading={suppliersStatus === 'loading'}
              customers={customers} transferTargets={transferTargets}
              cc1Options={cc1Options} cc2Options={cc2Options} buOptions={buOptions}
              showCC={showCC} showBU={showBU} selectedIds={selectedIds} rowSelections={rowSelections}
              allSelected={allSelected} tab={tab}
              onToggleSelect={toggleSelect}
              onSelectAll={() => setSelectedIds(allSelected ? new Set() : new Set(selectableTxIds))}
              onRowTypeChange={actions.handleRowTypeChange} onRowEntityChange={actions.handleRowEntityChange}
              onRowVatChange={actions.handleRowVatChange} onRowDimensionChange={actions.handleRowDimensionChange}
              onAccept={actions.handleAccept} onExclude={actions.handleExclude}
              onUnmatch={actions.handleUnmatch} onSplit={id => setSplitTxId(id)}
              onUpdateNotes={actions.handleUpdateNotes} onFindMatch={id => setFindMatchTxId(id)}
              onReverse={actions.handleReverse} onAttachments={id => setAttachmentsTxId(id)}
              onAskClient={id => setQueryTx(transactions.find(t => t.id === id) ?? null)}
              onCreateRule={tx => setCreateRuleTx(tx)}
              onCreateEntity={(txId, type) => { setCreateEntityTxId(txId); setCreateEntityType(type); }}
              onLink={tx => setLinkTx(tx)}
            />
          </BankTxListFrame>
        </div>

        <BankTxPagination page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />

        {tab === 'new' && transactions.length > 0 && (
          <BankTxReviewBar selectedCount={selectedIds.size} onReview={actions.handleBulkAccept} />
        )}
      </div>

      <BankTxModals
        transactions={transactions} glAccounts={glAccounts} suppliers={suppliers} customers={customers}
        cc2Options={cc2Options} buOptions={buOptions}
        bankAccounts={transferTargets}
        selectedBank={selectedBank} rowSelections={rowSelections} splitTxId={splitTxId}
        excludingTxId={excludingTxId} findMatchTxId={findMatchTxId} attachmentsTxId={attachmentsTxId}
        createRuleTx={createRuleTx} createEntityTxId={createEntityTxId} createEntityType={createEntityType}
        queryTx={queryTx} linkTx={linkTx}
        onLinkClose={() => setLinkTx(null)} onLinkDone={() => { setLinkTx(null); void loadTransactions(); }}
        onSplitClose={() => setSplitTxId(null)} onSplitDone={() => { setSplitTxId(null); void loadTransactions(); }}
        onExcludeClose={() => setExcludingTxId(null)} onExcludeConfirm={actions.handleExcludeConfirm}
        onFindMatchClose={() => setFindMatchTxId(null)} onFindMatchDone={() => { setFindMatchTxId(null); void loadTransactions(); }}
        onAttachmentsClose={() => setAttachmentsTxId(null)} onCreateRuleClose={() => setCreateRuleTx(null)}
        onCreateRuleDone={() => { setCreateRuleTx(null); setRowSelections(() => ({})); void loadTransactions(); refreshBankAccounts(); }}
        onCreateEntityClose={() => { setCreateEntityTxId(null); setCreateEntityType(null); }}
        onCreateEntityDone={(entity, type) => { actions.handleCreateEntityDone(entity, type, setGlAccounts, setSuppliers, setCustomers); setCreateEntityTxId(null); setCreateEntityType(null); }}
        onQueryClose={() => setQueryTx(null)}
        onQuerySent={() => setQueryTx(null)}
      />
    </AppLayout>
  );
}
