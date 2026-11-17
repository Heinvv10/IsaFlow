/**
 * Bank Transactions — Sage "Process Bank" equivalent.
 * Thin shell: state, data fetching, layout composition.
 * Action handlers: useBankTxActions | Ref data: useBankTxRefData | Bank accounts + figures: useBankTxSummary
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  BankTxTable,
  type AllocType, type SelectOption, type RowSelection,
} from '@/components/accounting/BankTxTable';
import { BankTxBankCards } from '@/components/accounting/bank-transactions/BankTxBankCards';
import { BankTxFilters } from '@/components/accounting/bank-transactions/BankTxFilters';
import { BankTxBatchPanel } from '@/components/accounting/bank-transactions/BankTxBatchPanel';
import { BankTxPageModals } from '@/components/accounting/bank-transactions/BankTxPageModals';
import { useBankTxModalState } from '@/components/accounting/bank-transactions/useBankTxModalState';
import { useBankTxSelection } from '@/components/accounting/bank-transactions/useBankTxSelection';
import { useBankTxFilters } from '@/components/accounting/bank-transactions/useBankTxFilters';
import { pruneSelection, selectedOnScreen } from '@/components/accounting/bank-transactions/bankTxSelectionView';
import { BankTxSelectionBar } from '@/components/accounting/bank-transactions/BankTxSelectionBar';
import { ActiveFiltersChip } from '@/components/accounting/bank-transactions/ActiveFiltersChip';
import { isBulkBusy, useBankTxBusy } from '@/components/accounting/bank-transactions/useBankTxBusy';
import { useBankTxSummary, type BankAccountSummary } from '@/components/accounting/bank-transactions/useBankTxSummary';
import { useBankTxView } from '@/components/accounting/bank-transactions/useBankTxView';
import { useBankCardOrder } from '@/components/accounting/bank-transactions/useBankCardOrder';
import { useActiveCompanyIdOrUndefined } from '@/contexts/CompanyContext';
import { firstCardAccount } from '@/components/accounting/bank-transactions/firstCardAccount';
import { readLastOpened } from '@/components/accounting/bank-transactions/lastOpenedSubAccount';
import { useRemoveRows } from '@/components/accounting/bank-transactions/useRemoveRows';
import { useScrollSelectedCard } from '@/components/accounting/bank-transactions/useScrollSelectedCard';
import { BankTxSummaryNotice } from '@/components/accounting/bank-transactions/BankTxSummaryNotice';
import { buildBankTxActions } from '@/components/accounting/bank-transactions/useBankTxActions';
import { useRelinkTransfersWithTick, TransferLinkNotice } from '@/components/accounting/bank-transactions/transferLinks';
import { useBankTxRefData } from '@/components/accounting/bank-transactions/useBankTxRefData';
import { useBankTxColumnPrefs } from '@/components/accounting/bank-transactions/useBankTxColumnPrefs';
import { useBankLineDetail } from '@/components/accounting/bank-transactions/useBankLineDetail';
import { DeepLinkNotice } from '@/components/accounting/bank-transactions/DeepLinkNotice';
import { useBankLineDeepLink } from '@/components/accounting/bank-transactions/useBankLineDeepLink';
import { BankTxSuppliersNotice, type SuppliersStatus } from '@/components/accounting/bank-transactions/BankTxSuppliersNotice';
import { BankEmptyState } from '@/components/accounting/banking/BankEmptyState';
import { AutoPostRunsPanel } from '@/components/accounting/bank-transactions/AutoPostRunsPanel';
import { CodingMetricsStrip } from '@/components/accounting/bank-transactions/CodingMetricsStrip';
import { actionableIds } from '@/components/accounting/bank-transactions/pendingFeedRow';
import { BankTxPagination, BankTxReviewBar } from '@/components/accounting/bank-transactions/BankTxPagination';
import { BankTxTabs, type BankTxTab as Tab } from '@/components/accounting/bank-transactions/BankTxTabs';
import { useLlmResultPoll } from '@/components/accounting/bank-transactions/useLlmResultPoll';
import { useSeedRowSelections } from '@/components/accounting/bank-transactions/useSeedRowSelections';
import { awaitingShown, filtersActive, listKey, transferTargetsFor } from '@/components/accounting/bank-transactions/bankTxPageView';
import { useBankTxList } from '@/components/accounting/bank-transactions/useBankTxList';
import { BankTxListFrame, BANK_TX_PAGE_SIZE as PAGE_SIZE } from '@/components/accounting/bank-transactions/BankTxListFrame';
import { bankTxPastEnd, usePageClamp } from '@/components/accounting/bank-transactions/usePageClamp';
import { exportAllBankTx, exportLoadedBankTx } from '@/components/accounting/bank-transactions/bankTxExport';

const NO_ACCOUNTS: BankAccountSummary[] = []; // a stable empty list (useBankTxSelection needs referentially stable accounts)

export default function BankTransactionsPage() {
  const router = useRouter();
  const [glAccounts, setGlAccounts] = useState<SelectOption[]>([]);
  const [suppliers, setSuppliers] = useState<SelectOption[]>([]);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [cc1Options, setCc1Options] = useState<SelectOption[]>([]);
  const [cc2Options, setCc2Options] = useState<SelectOption[]>([]);
  const [buOptions, setBuOptions] = useState<SelectOption[]>([]);
  const summary = useBankTxSummary();
  const bankAccounts = summary.accounts;
  // The default account is the first card in THIS user's order, so nothing is picked until that order is known. The same
  // source (one read of the preferences) is handed to the cards, which show and edit that order.
  const companyId = useActiveCompanyIdOrUndefined();
  const cardOrder = useBankCardOrder(companyId);
  const orderReady = companyId === undefined || cardOrder.loaded; // no company provider (a page test): nothing to wait for
  const pickDefault = useCallback((a: BankAccountSummary[]) => firstCardAccount(a, cardOrder.order, readLastOpened), [cardOrder.order]);
  const sel = useBankTxSelection(orderReady ? bankAccounts : NO_ACCOUNTS, router.isReady ? router.query.account_id : undefined, router.isReady, pickDefault);
  const { selected: selectedBank, setSelected: setSelectedBank } = sel;
  const [suppliersStatus, setSuppliersStatus] = useState<SuppliersStatus>('loading');
  useBankTxRefData({ setGlAccounts, setSuppliers, setCustomers, setCc1Options, setCc2Options, setBuOptions, setSuppliersStatus });
  // Filter / pagination
  const [tab, setTab] = useState<Tab>('new');
  const [page, setPage] = useState(1);
  const f = useBankTxFilters(setPage);
  const busy = useBankTxBusy();
  const { searchTerm, debouncedSearch, fromDate, toDate, fromAmount, toAmount, sortOrder, allocationFilter, txType, allocType, hasSuggestion, reconFilter } = f;
  // Selection / UI
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rowSelections, setRowSelections] = useState<Record<string, RowSelection>>({});
  const [smartRunning, setSmartRunning] = useState(false);
  const [showBatchEdit, setShowBatchEdit] = useState(false);
  const [batchType, setBatchType] = useState<AllocType>('account');
  const [batchSearch, setBatchSearch] = useState('');
  const { showCC, showBU, toggleCC, toggleBU } = useBankTxColumnPrefs();
  // Modal triggers
  const m = useBankTxModalState();
  const { setSplitTxId, setFindMatchTxId, setAttachmentsTxId, setQueryTx, setLinkTx, setCreateRuleTx, setCreateEntityTxId, setCreateEntityType } = m;
  // ---- The view (account, tab, page, filters) lives in the URL; switching account or tab is ONE batch (one fetch) ----
  const clearSelection = useCallback(() => { setSelectedIds(new Set()); setRowSelections({}); }, []);
  const { selectBank, changeTab, clampPage, latestQuery, restored } = useBankTxView({ router, bankAccounts, selectedBank, setSelectedBank, tab, setTab, page, setPage, f, clearSelection });
  const list = useBankTxList({ selectedBank, ready: router.isReady && restored, tab, page, pageSize: PAGE_SIZE, filters: f.values });
  const { transactions, setTransactions, isLoading, error, loaded, setLoaded } = list, total = loaded.total;
  const { detailTx: listTx, openDetail, closeDetail: closeListDetail } = useBankLineDetail(transactions);
  const { detailTx, closeDetail, error: deepLinkError, dismissError } = useBankLineDeepLink(listTx, closeListDetail, latestQuery);
  // THE reload for anything that writes: the list AND the summary (cards, tiles, statement panel), so they never disagree.
  const refreshSummary = summary.refresh;
  const reload = list.reload;
  const afterMutation = useCallback(() => { void reload(); void refreshSummary(); }, [reload, refreshSummary]);
  // EVERY post-mutation list reload goes through this (the view on screen NOW, not the one the action was clicked in).
  const reloadList = useCallback(() => { void reload(); }, [reload]);
  const reloadWithSummary = useCallback(async () => { await reload({ silent: true }); void refreshSummary(); }, [reload, refreshSummary]);

  // AI background poll — picks up late-arriving LLM suggestions after smart-categorize
  const { aiPolling, pollForLlmResults } = useLlmResultPoll(transactions, reloadWithSummary); // AI suggestions move lines Unallocated -> Suggested

  const [relinkFailed, linkTick] = useRelinkTransfersWithTick(selectedBank, afterMutation);

  useSeedRowSelections(transactions, rowSelections, setRowSelections); // rowSelections from DB suggestion fields

  // Scrolled when the selection changes AND again once the saved order has been applied (the card moves when it does).
  useScrollSelectedCard(selectedBank, bankAccounts.find(b => b.id === selectedBank)?.groupId, true, cardOrder.order);
  // The total is judged only once it was counted for THIS account and tab: a page restored from the URL is not "past the end" of a list not loaded yet.
  usePageClamp({ page, total, pageSize: PAGE_SIZE, isLoading: isLoading || loaded.key !== listKey(selectedBank, tab), failed: error !== '', setPage: clampPage });
  // Whatever changes the list (page, search, filter, sort, reload, an action) prunes the selection to the rows on screen.
  useEffect(() => { setSelectedIds(prev => pruneSelection(prev, transactions) ?? prev); }, [transactions]);

  const removeRows = useRemoveRows(transactions, setTransactions, setLoaded);

  // ---- Build action handlers ----
  const actions = buildBankTxActions({
    transactions, glAccounts, bankAccounts, selectedBank, selectedIds, rowSelections, batchType,
    excludingTxId: m.excludingTxId, createEntityTxId: m.createEntityTxId,
    setSmartRunning, setRowSelections, setTransactions, setSelectedIds, setShowBatchEdit,
    setRulePrompt: m.setRulePrompt, setExcludingTxId: m.setExcludingTxId, excludeOutcome: m.excludeOutcome, loadTransactions: reloadList, refreshBankAccounts: () => void refreshSummary(), refreshSummarySoon: summary.refreshSoon,
    reloadCurrentView: afterMutation,
    onLlmResidual: pollForLlmResults, busy, removeRows,
  });

  const bank = bankAccounts.find(b => b.id === selectedBank);
  const transferTargets: SelectOption[] = transferTargetsFor(bankAccounts, selectedBank); // active accounts only
  // Pending rows are read-only — select-all only ever selects the actionable
  // (non-pending) rows, so "all selected" is judged against that subset too.
  const selectableTxIds = actionableIds(transactions, transactions.map(t => t.id));
  const allSelected = selectableTxIds.length > 0 && selectableTxIds.every(id => selectedIds.has(id));
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Wrap a state setter so it always resets pagination to page 1
  function withReset<T>(fn: (v: T) => void) { return (v: T) => { fn(v); setPage(1); }; }

  const noBankAccounts = summary.status === 'ready' && bankAccounts.length === 0;
  const shown = awaitingShown({ tab, error, isLoading, total, loadedFor: loaded.key, wantedFor: listKey(selectedBank, tab), filtersActive: filtersActive({
    search: debouncedSearch, fromDate, toDate, fromAmount, toAmount, allocationFilter, txType, allocType, hasSuggestion }) });
  const onScreenSelected = selectedOnScreen(selectedIds, transactions);
  // The table stays mounted while the SAME list reloads (a page, a filter, an action): only a first load, or another account's
  // or tab's list, is a skeleton - the rows on screen would belong to a different view.
  // Accounts exist but none is chosen yet (the saved card order is still loading): that is loading, not an empty account.
  const choosing = bankAccounts.length > 0 && !selectedBank && !sel.noneActive;
  const refreshing = isLoading && loaded.key === listKey(selectedBank, tab) && transactions.length > 0;

  if (summary.status === 'error') {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)]">
          <h1 className="sr-only">Bank Transactions</h1>
          <BankTxSummaryNotice kind="error" message={summary.error} onRetry={() => void refreshSummary()} />
        </div>
      </AppLayout>
    );
  }

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
        {summary.stale && <BankTxSummaryNotice kind="stale" onRetry={() => void refreshSummary()} />}
        <BankTxBankCards bankAccounts={bankAccounts} selectedBank={selectedBank} shown={shown} onSelectBank={selectBank} cardOrder={cardOrder}
          onAccountsChanged={() => void refreshSummary()} onShowProvisional={() => changeTab('provisional')} />

        <BankTxTabs tab={tab} onTab={changeTab} provisionalCount={bank?.counts.provisional ?? 0} />

        <BankTxFilters
          tab={tab} page={page} total={total} pageSize={PAGE_SIZE} selectedCount={onScreenSelected.size}
          selectedBank={selectedBank} smartRunning={smartRunning} showCC={showCC} showBU={showBU}
          showBatchEdit={showBatchEdit} searchTerm={searchTerm} fromDate={fromDate} toDate={toDate}
          fromAmount={fromAmount} toAmount={toAmount} sortOrder={sortOrder}
          allocationFilter={allocationFilter} txType={txType} allocType={allocType} hasSuggestion={hasSuggestion}
          reconFilter={reconFilter} busy={busy.busy} progress={busy.progress} resetKey={f.resetTick}
          onRefresh={afterMutation} onBulkAccept={actions.handleBulkAccept}
          onBatchAccept={actions.handleBatchAccept} onBatchDelete={actions.handleBatchDelete}
          onToggleBatchEdit={() => { setShowBatchEdit(s => !s); setBatchSearch(''); }}
          onExport={() => exportLoadedBankTx(transactions, bank?.accountCode, bank?.accountName)} onExportAll={() => exportAllBankTx(fromDate, toDate)}
          onApplyRules={actions.handleApplyRules}
          onDownloadReport={() => actions.handleDownloadReport(bank?.accountCode)}
          onSearchChange={f.setSearchTerm}
          onFromDateChange={withReset(f.setFromDate)} onToDateChange={withReset(f.setToDate)}
          onFromAmountChange={withReset(f.setFromAmount)} onToAmountChange={withReset(f.setToAmount)}
          onSortOrderChange={withReset(f.setSortOrder)} onAllocationFilterChange={withReset(f.setAllocationFilter)}
          onTxTypeChange={withReset(f.setTxType)} onAllocTypeChange={withReset(f.setAllocType)}
          onHasSuggestionChange={withReset(f.setHasSuggestion)}
          onReconFilterChange={withReset(f.setReconFilter)}
          onToggleCC={toggleCC} onToggleBU={toggleBU}
        />

        <ActiveFiltersChip labels={f.activeLabels} onClear={f.clear} />
        <BankTxSelectionBar count={onScreenSelected.size} onClear={() => setSelectedIds(new Set())} />
        <BankTxSuppliersNotice status={suppliersStatus} />

        <BankTxBatchPanel
          showBatchEdit={showBatchEdit} selectedCount={onScreenSelected.size} batchType={batchType}
          batchSearch={batchSearch} glAccounts={glAccounts} suppliers={suppliers} suppliersLoading={suppliersStatus === 'loading'} customers={customers}
          transferTargets={transferTargets}
          rulePrompt={m.rulePrompt}
          onBatchTypeChange={t => { setBatchType(t); setBatchSearch(''); }}
          onBatchSearchChange={setBatchSearch} onApplyBatchEdit={actions.handleApplyBatchEdit}
          onCancelBatchEdit={() => setShowBatchEdit(false)}
          onCreateRule={tx => { setCreateRuleTx(tx); m.setRulePrompt(null); }}
          onDismissRulePrompt={() => m.setRulePrompt(null)}
        />

        {/* Table */}
        <div className="px-4 py-2">
          <CodingMetricsStrip />
          <AutoPostRunsPanel onUndone={afterMutation} />
          <TransferLinkNotice bankAccountId={selectedBank} refreshKey={linkTick} onChanged={afterMutation} />
          <DeepLinkNotice message={deepLinkError} onDismiss={dismissError} />
          <DeepLinkNotice message={sel.notice} onDismiss={sel.dismissNotice} />
          {sel.noneActive && <BankTxSummaryNotice kind="none-active" />}
          {!sel.noneActive && <BankTxListFrame relinkFailed={relinkFailed} aiPolling={aiPolling} isLoading={(isLoading || summary.status === 'loading' || choosing) && !refreshing} refreshing={refreshing} error={error}
            empty={transactions.length === 0} pastEnd={bankTxPastEnd(loaded.page, total, PAGE_SIZE)} tab={tab} activeFilters={f.activeLabels}
            detailTx={detailTx} onDetailClose={closeDetail}>
            <BankTxTable
              transactions={transactions} glAccounts={glAccounts} suppliers={suppliers} suppliersLoading={suppliersStatus === 'loading'}
              customers={customers} transferTargets={transferTargets}
              cc1Options={cc1Options} cc2Options={cc2Options} buOptions={buOptions}
              showCC={showCC} showBU={showBU} selectedIds={selectedIds} rowSelections={rowSelections} busyIds={busy.busy}
              allSelected={allSelected} tab={tab}
              onToggleSelect={toggleSelect}
              onSelectAll={() => setSelectedIds(allSelected ? new Set() : new Set(selectableTxIds))}
              onRowTypeChange={actions.handleRowTypeChange} onRowEntityChange={actions.handleRowEntityChange}
              onRowVatChange={actions.handleRowVatChange} onRowDimensionChange={actions.handleRowDimensionChange}
              onAccept={actions.handleAccept} onExclude={actions.handleExclude}
              onUnmatch={actions.handleUnmatch} onSplit={id => { setSplitTxId(id); return m.splitOutcome.begin(); }}
              onUpdateNotes={actions.handleUpdateNotes} onFindMatch={id => setFindMatchTxId(id)}
              onReverse={actions.handleReverse} onAttachments={id => setAttachmentsTxId(id)}
              onAskClient={id => setQueryTx(transactions.find(t => t.id === id) ?? null)}
              onCreateRule={tx => setCreateRuleTx(tx)}
              onCreateEntity={(txId, type) => { setCreateEntityTxId(txId); setCreateEntityType(type); }}
              onLink={tx => setLinkTx(tx)} onOpenDetails={openDetail}
            />
          </BankTxListFrame>}
        </div>

        <BankTxPagination page={page} total={total} pageSize={PAGE_SIZE} onPage={setPage} />

        {tab === 'new' && transactions.length > 0 && (
          <BankTxReviewBar selectedCount={onScreenSelected.size} onReview={actions.handleBulkAccept} busy={isBulkBusy(busy.busy)} />
        )}
      </div>

      <BankTxPageModals
        m={m} actions={actions} transactions={transactions} glAccounts={glAccounts} suppliers={suppliers} customers={customers}
        cc2Options={cc2Options} buOptions={buOptions} transferTargets={transferTargets} selectedBank={selectedBank}
        rowSelections={rowSelections} afterMutation={afterMutation} setRowSelections={setRowSelections}
        setTransactions={setTransactions} setGlAccounts={setGlAccounts} setSuppliers={setSuppliers} setCustomers={setCustomers}
      />
    </AppLayout>
  );
}
