import {AppLayout} from '@/components/layout/AppLayout';
import {BankTxTable} from '../BankTxTable';
import {BankTxBankCards} from './BankTxBankCards';
import {BankTxFilters} from './BankTxFilters';
import {BankTxBatchPanel} from './BankTxBatchPanel';
import {BankTxModals} from './BankTxModals';
import {BankControlDialog} from './BankControlDialog';
import {Loader2,AlertCircle} from 'lucide-react';
import {BankEmptyState} from '../banking/BankEmptyState';
import {AutoPostRunsPanel} from './AutoPostRunsPanel';
import {PAGE_SIZE,type Tab,type useBankTransactionsController} from './useBankTransactionsController';
export function BankTransactionsView(props:ReturnType<typeof useBankTransactionsController>){
 const {
  bankControl,glAccounts,setGlAccounts,suppliers,setSuppliers,customers,setCustomers,cc1Options,
  cc2Options,buOptions,bankAccounts,selectedBank,setSelectedBank,refreshBankAccounts,transactions,isLoading,
  error,relinkFailed,tab,setTab,page,setPage,total,searchTerm,
  setSearchTerm,fromDate,setFromDate,toDate,setToDate,fromAmount,setFromAmount,toAmount,
  setToAmount,sortOrder,setSortOrder,allocationFilter,setAllocationFilter,txType,setTxType,allocType,
  setAllocType,hasSuggestion,setHasSuggestion,selectedIds,setSelectedIds,rowSelections,setRowSelections,smartRunning,
  showBatchEdit,setShowBatchEdit,batchType,setBatchType,batchSearch,setBatchSearch,showCC,setShowCC,
  showBU,setShowBU,splitTxId,setSplitTxId,excludingTxId,setExcludingTxId,findMatchTxId,setFindMatchTxId,
  attachmentsTxId,setAttachmentsTxId,queryTx,setQueryTx,createRuleTx,setCreateRuleTx,rulePrompt,setRulePrompt,
  createEntityTxId,setCreateEntityTxId,createEntityType,setCreateEntityType,loadTransactions,aiPolling,actions,bank,
  transferTargets,totalPages,allSelected,toggleSelect,withReset,noBankAccounts
 }=props;
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
          <AutoPostRunsPanel onUndone={loadTransactions} />
          {relinkFailed && (
            <div className="flex items-center gap-2 text-xs text-amber-400 py-1 pb-2">
              <AlertCircle className="h-3 w-3" /> Transfer re-linking failed for this account — counterpart transfers may still show as unallocated.
            </div>
          )}
          {aiPolling > 0 && (
            <div className="flex items-center gap-2 text-xs text-[var(--ff-text-secondary)] py-1 pb-2">
              <Loader2 className="h-3 w-3 animate-spin" /> AI is categorizing {aiPolling} transaction{aiPolling === 1 ? '' : 's'}…
            </div>
          )}
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
              customers={customers} transferTargets={transferTargets}
              cc1Options={cc1Options} cc2Options={cc2Options} buOptions={buOptions}
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
              onAskClient={id => setQueryTx(transactions.find(t => t.id === id) ?? null)}
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

      <BankControlDialog workflow={bankControl} accounts={glAccounts}/>
      <BankTxModals
        transactions={transactions} glAccounts={glAccounts} suppliers={suppliers} customers={customers}
        bankAccounts={transferTargets}
        selectedBank={selectedBank} rowSelections={rowSelections} splitTxId={splitTxId}
        excludingTxId={excludingTxId} findMatchTxId={findMatchTxId} attachmentsTxId={attachmentsTxId}
        createRuleTx={createRuleTx} createEntityTxId={createEntityTxId} createEntityType={createEntityType}
        queryTx={queryTx}
        onSplitClose={() => setSplitTxId(null)} onPrepareSplit={preparation=>{const bankTransactionId=splitTxId;if(!bankTransactionId)return;setSplitTxId(null);void bankControl.open({bankTransactionId,mode:'allocate',preparation}).then(outcome=>{if(outcome==='posted'){void loadTransactions();refreshBankAccounts();}});}}
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
