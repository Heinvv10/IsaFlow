import {useBankTransferRelink} from './useBankTransferRelink';
import {useState,useEffect,useCallback,useRef} from 'react';
import {useRouter} from 'next/router';
import {apiFetch} from '@/lib/apiFetch';
import type {AllocType,BankTx,SelectOption,RowSelection} from '../BankTxTable';
import type {BankAcct} from './BankTxBankCards';
import type {RulePrompt} from './BankTxBatchPanel';
import {buildBankTxActions} from './useBankTxActions';
import {useBankControlWorkflow} from './useBankControlWorkflow';
import {useBankTxRefData} from './useBankTxRefData';
import {useBankControlResume} from './useBankControlResume';
export type Tab = 'new' | 'reviewed' | 'excluded';
export const PAGE_SIZE = 25;

function tabToStatus(tab: Tab): string {
  if (tab === 'new') return 'imported';
  if (tab === 'excluded') return 'excluded';
  return 'matched';
}

export function useBankTransactionsController() {
  const bankControl=useBankControlWorkflow();
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
  const transferRelink = useBankTransferRelink(selectedBank);
  const [refDataLoaded, setRefDataLoaded] = useState(false);
  const didApplyQueryParam = useRef(false);
  const { refreshBankAccounts } = useBankTxRefData({ setBankAccounts, setGlAccounts, setSuppliers, setCustomers, setCc1Options, setCc2Options, setBuOptions, setSelectedBank, setRefDataLoaded });

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
    if (!selectedBank) { setIsLoading(false); setTransactions([]); setTotal(0); return; }
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

  useEffect(() => { void loadTransactions(); }, [loadTransactions]);
  useBankControlResume(bankControl,()=>{void loadTransactions();refreshBankAccounts();transferRelink.refresh();});

  // AI background poll — picks up late-arriving LLM suggestions after smart-categorize
  const [aiPolling, setAiPolling] = useState(0);
  const transactionsRef = useRef<BankTx[]>([]);
  useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
  const aiPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current); }, []);

  const pollForLlmResults = useCallback((residualCount: number) => {
    if (residualCount <= 0) return;
    if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current);
    setAiPolling(residualCount);
    let ticks = 0;
    let lastLlm = -1;
    aiPollTimerRef.current = setInterval(async () => {
      ticks += 1;
      await loadTransactions();
      const llmCount = transactionsRef.current.filter((t) => t.suggestedStrategy === 'llm').length;
      if ((llmCount === lastLlm && ticks > 1) || ticks >= 8) {
        if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current);
        aiPollTimerRef.current = null;
        setAiPolling(0);
      }
      lastLlm = llmCount;
    }, 4000);
  }, [loadTransactions]);


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
    setRulePrompt, setExcludingTxId, loadTransactions, refreshBankAccounts,
    openBankControl:async input=>{const outcome=await bankControl.open(input);if(outcome==='posted')transferRelink.refresh();return outcome;},
    onLlmResidual: pollForLlmResults,
  });

  const bank = bankAccounts.find(b => b.id === selectedBank);
  // Transfer targets — every other bank GL account (source bank excluded).
  // Sub-accounts carry their group name so 20+ paycards stay scannable.
  const transferTargets: SelectOption[] = bankAccounts
    .filter(b => b.id !== selectedBank)
    .map(b => ({ id: b.id, code: b.accountCode, name: b.groupName ? `${b.groupName} › ${b.accountName}` : b.accountName }));
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const allSelected = transactions.length > 0 && transactions.every(t => selectedIds.has(t.id));
  const toggleSelect = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Wrap a state setter so it always resets pagination to page 1
  function withReset<T>(fn: (v: T) => void) { return (v: T) => { fn(v); setPage(1); }; }

  const noBankAccounts = refDataLoaded && bankAccounts.length === 0;

  return {
  bankControl,glAccounts,setGlAccounts,suppliers,setSuppliers,customers,setCustomers,cc1Options,
  cc2Options,buOptions,bankAccounts,selectedBank,setSelectedBank,refreshBankAccounts,transactions,isLoading,
  error,transferRelink,tab,setTab,page,setPage,total,searchTerm,
  setSearchTerm,fromDate,setFromDate,toDate,setToDate,fromAmount,setFromAmount,toAmount,
  setToAmount,sortOrder,setSortOrder,allocationFilter,setAllocationFilter,txType,setTxType,allocType,
  setAllocType,hasSuggestion,setHasSuggestion,selectedIds,setSelectedIds,rowSelections,setRowSelections,smartRunning,
  showBatchEdit,setShowBatchEdit,batchType,setBatchType,batchSearch,setBatchSearch,showCC,setShowCC,
  showBU,setShowBU,splitTxId,setSplitTxId,excludingTxId,setExcludingTxId,findMatchTxId,setFindMatchTxId,
  attachmentsTxId,setAttachmentsTxId,queryTx,setQueryTx,createRuleTx,setCreateRuleTx,rulePrompt,setRulePrompt,
  createEntityTxId,setCreateEntityTxId,createEntityType,setCreateEntityType,loadTransactions,aiPolling,actions,bank,
  transferTargets,totalPages,allSelected,toggleSelect,withReset,noBankAccounts
  };
}
