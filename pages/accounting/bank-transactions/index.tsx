/**
 * Bank Transactions — Sage "Process Bank" equivalent
 * Type: Account / Supplier / Customer — Selection changes accordingly
 * Full toolbar: Mark Reviewed, Delete, Batch Edit, Import, Export, Search
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  BankTxTable, type AllocType, type VatCode, type BankTx, type SelectOption, type RowSelection,
} from '@/components/accounting/BankTxTable';
import { extractPattern } from '@/components/accounting/CreateRuleModal';
import { StatementBalanceWidget } from '@/components/accounting/StatementBalanceWidget';

// Lazy-load modals — only loaded when opened
const SplitTransactionModal = dynamic(() => import('@/components/accounting/SplitTransactionModal').then(m => ({ default: m.SplitTransactionModal })), { ssr: false });
const ExcludeReasonModal = dynamic(() => import('@/components/accounting/ExcludeReasonModal').then(m => ({ default: m.ExcludeReasonModal })), { ssr: false });
const FindMatchModal = dynamic(() => import('@/components/accounting/FindMatchModal').then(m => ({ default: m.FindMatchModal })), { ssr: false });
const BankTxAttachmentsModal = dynamic(() => import('@/components/accounting/BankTxAttachmentsModal').then(m => ({ default: m.BankTxAttachmentsModal })), { ssr: false });
const CreateRuleModal = dynamic(() => import('@/components/accounting/CreateRuleModal').then(m => ({ default: m.CreateRuleModal })), { ssr: false });
const CreateEntityModal = dynamic(() => import('@/components/accounting/CreateEntityModal').then(m => ({ default: m.CreateEntityModal })), { ssr: false });
import {
  Loader2, AlertCircle, RefreshCw, CheckCheck, Upload, Download, Search, Trash2, Layers, Zap, Plus, FileText,
} from 'lucide-react';
import { notify } from '@/utils/toast';
import Link from 'next/link';
import { formatCurrency as fmtCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface BankAcct {
  id: string;
  accountCode: string;
  accountName: string;
  bankAccountNumber?: string | null;
  balance: number;
  reconciledBalance: number;
  unreconciledBalance: number;
  unreconciledCount: number;
}
type Tab = 'new' | 'reviewed' | 'excluded';
const PAGE_SIZE = 25;

/** Maps UI tabs to bank_transactions.status values */
function tabToStatus(tab: Tab): string {
  if (tab === 'new') return 'imported';
  if (tab === 'excluded') return 'excluded';
  return 'matched';
}

export default function BankTransactionsPage() {
  const [transactions, setTransactions] = useState<BankTx[]>([]);
  const [glAccounts, setGlAccounts] = useState<SelectOption[]>([]);
  const [suppliers, setSuppliers] = useState<SelectOption[]>([]);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [cc1Options, setCc1Options] = useState<SelectOption[]>([]);
  const [cc2Options, setCc2Options] = useState<SelectOption[]>([]);
  const [buOptions, setBuOptions] = useState<SelectOption[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAcct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedBank, setSelectedBank] = useState('');
  const [tab, setTab] = useState<Tab>('new');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  /** Minimum transaction amount filter (Rand value, empty = no lower bound) */
  const [fromAmount, setFromAmount] = useState('');
  /** Maximum transaction amount filter (Rand value, empty = no upper bound) */
  const [toAmount, setToAmount] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const amountDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [rowSelections, setRowSelections] = useState<Record<string, RowSelection>>({});
  const [showBatchEdit, setShowBatchEdit] = useState(false);
  const [batchType, setBatchType] = useState<AllocType>('account');
  const [batchSearch, setBatchSearch] = useState('');

  const [splitTxId, setSplitTxId] = useState<string | null>(null);
  /** ID of transaction awaiting an exclusion reason — shows ExcludeReasonModal when set */
  const [excludingTxId, setExcludingTxId] = useState<string | null>(null);
  const [findMatchTxId, setFindMatchTxId] = useState<string | null>(null);
  const [attachmentsTxId, setAttachmentsTxId] = useState<string | null>(null);
  const [createRuleTx, setCreateRuleTx] = useState<BankTx | null>(null);
  const [rulePrompt, setRulePrompt] = useState<{ tx: BankTx; matchCount: number } | null>(null);
  const [createEntityTxId, setCreateEntityTxId] = useState<string | null>(null);
  const [createEntityType, setCreateEntityType] = useState<AllocType | null>(null);

  // Load reference data — all requests fire in parallel via Promise.all
  useEffect(() => {
    Promise.all([
      apiFetch('/api/accounting/bank-accounts').then(r => r.json()),
      apiFetch('/api/accounting/chart-of-accounts').then(r => r.json()),
      apiFetch('/api/accounting/suppliers-list?status=active').then(r => r.json()),
      apiFetch('/api/accounting/customers').then(r => r.json()),
      apiFetch('/api/accounting/cost-centres?cc_type=cc1&active=true').then(r => r.json()),
      apiFetch('/api/accounting/cost-centres?cc_type=cc2&active=true').then(r => r.json()),
      apiFetch('/api/accounting/cost-centres?active=true').then(r => r.json()),
    ]).then(([bankJson, coaJson, suppJson, clientJson, cc1Json, cc2Json, deptJson]) => {
      const bankList = Array.isArray(bankJson.data || bankJson) ? (bankJson.data || bankJson) : [];
      setBankAccounts(bankList);
      if (bankList.length > 0) setSelectedBank(prev => prev || bankList[0].id);

      const coaList = Array.isArray(coaJson.data || coaJson) ? (coaJson.data || coaJson) : [];
      setGlAccounts(coaList
        .filter((a: SelectOption & { accountSubtype?: string }) => a.accountSubtype !== 'bank')
        .map((a: SelectOption & { accountCode?: string; accountName?: string; defaultVatCode?: string }) => ({
          id: a.id, code: a.accountCode || a.code, name: a.accountName || a.name,
          defaultVatCode: a.defaultVatCode,
        }))
      );

      const suppList = Array.isArray(suppJson.data) ? suppJson.data : [];
      setSuppliers(suppList.map((s: { id: number | string; name: string; code?: string }) => ({
        id: String(s.id), name: s.name, code: s.code,
      })));

      const clientList = Array.isArray(clientJson.data) ? clientJson.data : [];
      setCustomers(clientList.map((c: { id: string; name: string }) => ({
        id: c.id, name: c.name || '',
      })));

      const cc1List = Array.isArray(cc1Json.data?.items) ? cc1Json.data.items : [];
      setCc1Options(cc1List.map((c: { id: string; code: string; name: string }) => ({ id: c.id, code: c.code, name: c.name })));

      const cc2List = Array.isArray(cc2Json.data?.items) ? cc2Json.data.items : [];
      setCc2Options(cc2List.map((c: { id: string; code: string; name: string }) => ({ id: c.id, code: c.code, name: c.name })));

      const deptList = Array.isArray(deptJson.data || deptJson) ? (deptJson.data || deptJson) : [];
      setBuOptions(deptList.filter((d: { is_active?: boolean; isActive?: boolean }) => d.is_active !== false && d.isActive !== false)
        .map((d: { id: string; name: string; code?: string }) => ({ id: d.id, name: d.name, code: d.code })));
    }).catch(() => { /* reference data load failure — non-critical, UI handles empty lists */ });
  }, []);

  // Debounce search input — 500ms delay before firing server request
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setPage(1);
    }, 500);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchTerm]);

  // Load transactions — server-side filtering for search, dates, amount range, status
  const loadTransactions = useCallback(async () => {
    if (!selectedBank) return;
    setIsLoading(true);
    setError('');
    try {
      const status = tabToStatus(tab);
      const offset = (page - 1) * PAGE_SIZE;
      const params = new URLSearchParams({
        bank_account_id: selectedBank, status, limit: String(PAGE_SIZE), offset: String(offset),
      });
      if (fromDate) params.set('from_date', fromDate);
      if (toDate) params.set('to_date', toDate);
      if (fromAmount) params.set('from_amount', fromAmount);
      if (toAmount) params.set('to_amount', toAmount);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await apiFetch(`/api/accounting/bank-transactions?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setTransactions(data.transactions || []);
      setTotal(data.total || 0);
    } catch {
      setError('Failed to load transactions');
    } finally {
      setIsLoading(false);
    }
  }, [selectedBank, tab, page, fromDate, toDate, fromAmount, toAmount, debouncedSearch]);

  useEffect(() => { loadTransactions(); }, [loadTransactions]);

  // Seed rowSelections from suggestion fields on newly-loaded transactions
  useEffect(() => {
    if (transactions.length === 0) return;
    const initialSelections: Record<string, RowSelection> = {};
    for (const tx of transactions) {
      // Skip only if user has already picked a specific entity — an empty selection (type set, no entity)
      // should be overridden by fresh DB suggestions (e.g. after Apply Rules runs)
      if (rowSelections[tx.id]?.entityId) continue;
      // VAT only applies to GL account allocations; supplier/customer VAT is handled on their own invoices
      const dimFields = { cc1Id: tx.cc1Id, cc2Id: tx.cc2Id, buId: tx.buId };
      if (tx.suggestedSupplierId) {
        initialSelections[tx.id] = {
          type: 'supplier' as AllocType,
          entityId: tx.suggestedSupplierId,
          label: tx.suggestedSupplierName || tx.suggestedCategory || '',
          vatCode: 'none', ...dimFields,
        };
      } else if (tx.suggestedClientId) {
        initialSelections[tx.id] = {
          type: 'customer' as AllocType,
          entityId: tx.suggestedClientId,
          label: tx.suggestedClientName || tx.suggestedCategory || '',
          vatCode: 'none', ...dimFields,
        };
      } else if (tx.suggestedGlAccountId) {
        initialSelections[tx.id] = {
          type: 'account' as AllocType,
          entityId: tx.suggestedGlAccountId,
          label: tx.suggestedGlAccountCode
            ? `${tx.suggestedGlAccountCode} ${tx.suggestedGlAccountName || ''}`
            : tx.suggestedGlAccountName || tx.suggestedCategory || '',
          vatCode: (tx.suggestedVatCode || 'none') as VatCode, ...dimFields,
        };
      }
    }
    if (Object.keys(initialSelections).length > 0) {
      // Merge: DB suggestions fill in empty slots; existing selections with an entityId win
      setRowSelections(prev => {
        const merged = { ...prev };
        for (const [id, sel] of Object.entries(initialSelections)) {
          if (!merged[id]?.entityId) merged[id] = sel;
        }
        return merged;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
    setRowSelections({});
  }, [selectedBank, tab]);

  // API helpers
  const callAction = async (body: Record<string, string>) => {
    const res = await apiFetch('/api/accounting/bank-transactions-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
      const msg = json.error?.message || json.message || (typeof json.error === 'string' ? json.error : 'Action failed');
      throw new Error(msg);
    }
    return json;
  };

  // Fire-and-forget: persist dropdown selection to DB so it survives page refresh
  const saveSelection = (txId: string, type: AllocType, entityId: string, vatCode?: string) => {
    apiFetch('/api/accounting/bank-transactions-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'save_selection', bankTransactionId: txId, selectionType: type, selectionEntityId: entityId || null, vatCode: vatCode || null }),
    }).catch(() => { /* fire-and-forget: selection persist failure is non-critical, selection still shown in UI */ });
  };

  // Fire-and-forget: persist CC1/CC2/BU dimension changes
  const saveDimensions = (txId: string, cc1Id: string, cc2Id: string, buId: string) => {
    apiFetch('/api/accounting/bank-transactions-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'save_dimensions', bankTransactionId: txId, cc1Id: cc1Id || null, cc2Id: cc2Id || null, buId: buId || null }),
    }).catch(() => { /* fire-and-forget: dimension persist failure is non-critical, dimensions still shown in UI */ });
  };

  const handleAccept = async (txId: string) => {
    const sel = rowSelections[txId];
    if (!sel?.entityId) { notify.error('Select an account/supplier/customer first'); return; }
    const tx = transactions.find(t => t.id === txId);
    try {
      const body: Record<string, string> = {
        action: 'allocate', bankTransactionId: txId, allocationType: sel.type,
        vatCode: sel.vatCode || 'none',
      };
      if (sel.type === 'account') body.contraAccountId = sel.entityId;
      else body.entityId = sel.entityId;
      if (sel.cc1Id) body.cc1Id = sel.cc1Id;
      if (sel.cc2Id) body.cc2Id = sel.cc2Id;
      if (sel.buId) body.buId = sel.buId;
      await callAction(body);
      notify.success('Transaction allocated');
      loadTransactions();
      // Learn from this allocation for smart categorization (fire-and-forget)
      if (sel.type === 'account' && sel.entityId) {
        apiFetch('/api/accounting/smart-categorize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'learn', txId, glAccountId: sel.entityId, category: sel.label, vatCode: sel.vatCode }),
        }).catch(() => { /* fire-and-forget: smart-categorize learn failure is non-critical */ });
      }
      // After allocation, check if there are other similar unprocessed transactions
      // to suggest creating a categorisation rule
      if (tx?.description && selectedBank) {
        const pattern = extractPattern(tx.description);
        if (pattern.trim().length >= 3) {
          try {
            const params = new URLSearchParams({ pattern, matchType: 'contains', bankAccountId: selectedBank });
            const res = await apiFetch(`/api/accounting/bank-rules-preview?${params}`);
            const json = await res.json();
            const matchCount = json.data?.matchCount ?? 0;
            if (matchCount > 0) setRulePrompt({ tx, matchCount });
          } catch { /* non-critical — ignore preview errors */ }
        }
      }
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed'); }
  };

  /** Opens the ExcludeReasonModal — actual API call happens in handleExcludeConfirm */
  const handleExclude = (txId: string) => {
    setExcludingTxId(txId);
  };

  /** Called by ExcludeReasonModal on confirm — posts to API with reason then reloads */
  const handleExcludeConfirm = async (reason: string) => {
    if (!excludingTxId) return;
    const txId = excludingTxId;
    setExcludingTxId(null);
    try {
      await callAction({ action: 'exclude', bankTransactionId: txId, excludeReason: reason });
      notify.success('Transaction excluded');
      loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to exclude'); }
  };

  const handleUnmatch = async (txId: string) => {
    try {
      await callAction({ action: 'unmatch', bankTransactionId: txId });
      notify.success('Allocation undone');
      loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed'); }
  };

  const handleSplit = (txId: string) => {
    setSplitTxId(txId);
  };

  /**
   * Save notes/memo for a single bank transaction.
   * Updates local state optimistically so the cell does not flicker.
   */
  const handleUpdateNotes = async (txId: string, notes: string) => {
    // Optimistic local update — keep UI in sync without a reload
    setTransactions(prev =>
      prev.map(tx => tx.id === txId ? { ...tx, notes: notes || undefined } : tx)
    );
    try {
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'update_notes', bankTransactionId: txId, notes }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || 'Failed to save note');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Failed to save note');
      // Revert optimistic update on error
      loadTransactions();
    }
  };

  const handleBatchAccept = async () => {
    const toAccept = Array.from(selectedIds).filter(id => rowSelections[id]?.entityId);
    if (toAccept.length === 0) { notify.error('Select transactions with accounts assigned'); return; }
    let ok = 0, fail = 0;
    for (const txId of toAccept) {
      try {
        const sel = rowSelections[txId];
        if (!sel) continue;
        const body: Record<string, string> = {
          action: 'allocate', bankTransactionId: txId, allocationType: sel.type,
          vatCode: sel.vatCode || 'none',
        };
        if (sel.type === 'account') body.contraAccountId = sel.entityId;
        else body.entityId = sel.entityId;
        if (sel.cc1Id) body.cc1Id = sel.cc1Id;
        if (sel.cc2Id) body.cc2Id = sel.cc2Id;
        if (sel.buId) body.buId = sel.buId;
        await callAction(body);
        ok++;
      } catch { fail++; }
    }
    notify.success(`${ok} allocated${fail ? `, ${fail} failed` : ''}`);
    setSelectedIds(new Set());
    loadTransactions();
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} transaction(s)? This cannot be undone.`)) return;
    try {
      await callAction({ action: 'delete', bankTransactionIds: Array.from(selectedIds) } as unknown as Record<string, string>);
      notify.success(`${selectedIds.size} transaction(s) deleted`);
      setSelectedIds(new Set());
      loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Delete failed'); }
  };

  const handleBulkAccept = async () => {
    if (selectedIds.size === 0) return;
    try {
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'bulk_accept', bankTransactionIds: Array.from(selectedIds) }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || 'Failed to mark as reviewed');
      notify.success(`${json.data?.accepted ?? selectedIds.size} transaction(s) marked as reviewed`);
      setSelectedIds(new Set());
      loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to mark as reviewed'); }
  };

  const handleExport = () => {
    const rows = transactions.map(tx => ({
      Date: tx.transactionDate,
      Description: tx.description || '',
      Reference: tx.reference || '',
      Spent: tx.amount < 0 ? Math.abs(tx.amount) : '',
      Received: tx.amount > 0 ? tx.amount : '',
      Status: tx.status,
    }));
    const header = Object.keys(rows[0] || {}).join(',');
    const csv = [header, ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bank-transactions-${bank?.accountCode || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Apply batch edit selection to all selected rows
  const applyBatchEdit = (entityId: string, label: string) => {
    const updates: Record<string, RowSelection> = { ...rowSelections };
    let autoVat: VatCode | undefined;
    if (batchType === 'account' && entityId) {
      const acct = glAccounts.find(g => g.id === entityId);
      if (acct?.defaultVatCode && acct.defaultVatCode !== 'none') {
        autoVat = acct.defaultVatCode as VatCode;
      }
    }
    selectedIds.forEach(id => {
      const vatCode = autoVat ?? (updates[id]?.vatCode || 'none') as VatCode;
      updates[id] = { type: batchType, entityId, label, vatCode };
    });
    setRowSelections(updates);
    setShowBatchEdit(false);
    notify.success(`Applied ${batchType} "${label}" to ${selectedIds.size} rows`);
  };

  // Quick Win 4: Apply bank categorisation rules + smart categorization to current account
  const handleApplyRules = async () => {
    if (!selectedBank) { notify.error('Select a bank account first'); return; }
    try {
      // Step 1: Apply explicit bank rules first
      const rulesRes = await apiFetch('/api/accounting/bank-rules-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'apply', bankAccountId: selectedBank }),
      });
      const rulesJson = await rulesRes.json();
      if (!rulesRes.ok || rulesJson.success === false) throw new Error(rulesJson.message || 'Apply rules failed');
      const rulesResult = rulesJson.data || {};

      // Step 2: Run smart categorization on remaining uncategorized transactions
      const smartRes = await apiFetch('/api/accounting/smart-categorize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'categorize', bankAccountId: selectedBank }),
      });
      const smartJson = await smartRes.json();
      const smartResult = smartJson.data || {};

      const rulesApplied = rulesResult.applied ?? 0;
      const smartCategorized = smartResult.categorized ?? 0;
      const totalSkipped = smartResult.skipped ?? 0;

      if (rulesApplied + smartCategorized > 0) {
        notify.success(`${rulesApplied} rules applied, ${smartCategorized} smart-categorised, ${totalSkipped} skipped`);
      } else {
        notify.success('No new categorisations found');
      }
      loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to apply rules'); }
  };

  const handleReverse = async (txId: string) => {
    const tx = transactions.find(t => t.id === txId);
    const msg = tx?.status === 'allocated'
      ? 'Undo this allocation? The journal entry will be reversed.'
      : 'Reverse this transaction? The associated journal entry will also be reversed.';
    if (!window.confirm(msg)) return;
    try {
      await callAction({ action: 'reverse', bankTransactionId: txId });
      notify.success(tx?.status === 'allocated' ? 'Allocation undone' : 'Transaction reversed');
      loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Reverse failed'); }
  };

  const handleDownloadReport = async () => {
    if (!selectedBank) return;
    try {
      const res = await apiFetch(`/api/accounting/bank-reconciliation-report?bankAccountId=${selectedBank}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      const data = json.data || json;
      const { generateReconReport } = await import('@/modules/accounting/utils/reconReportPdf');
      const blob = await generateReconReport(data);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `recon-report-${bank?.accountCode || 'bank'}.pdf`;
      a.click(); URL.revokeObjectURL(url);
      notify.success('Report downloaded');
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Report failed'); }
  };

  const bank = bankAccounts.find(b => b.id === selectedBank);
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const allSelected = transactions.length > 0 && transactions.every(t => selectedIds.has(t.id));

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  // Batch edit options
  const batchOptions = useMemo(() => {
    const opts = batchType === 'supplier' ? suppliers : batchType === 'customer' ? customers : glAccounts;
    if (!batchSearch) return opts.slice(0, 30);
    const q = batchSearch.toLowerCase();
    return opts.filter(o => (o.code || '').toLowerCase().includes(q) || o.name.toLowerCase().includes(q)).slice(0, 30);
  }, [batchType, batchSearch, glAccounts, suppliers, customers]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header — bank account cards */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-3">Banking</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {bankAccounts.map(b => {
              const active = b.id === selectedBank;
              const gap = b.unreconciledBalance;
              const hasGap = Math.abs(gap) >= 0.01;
              return (
                <button key={b.id} onClick={() => setSelectedBank(b.id)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border-2 transition-all text-left ${
                    active
                      ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
                      : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
                  }`}>
                  <div className={`w-2 h-14 rounded-full shrink-0 ${active ? 'bg-teal-500' : 'bg-[var(--ff-border-light)]'}`} />
                  <div>
                    <p className={`text-sm font-semibold ${active ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
                      {b.accountName}
                    </p>
                    <p className="text-xs text-[var(--ff-text-tertiary)] font-mono">
                      {b.accountCode}
                      {b.bankAccountNumber && <span className="ml-1.5">| ****{b.bankAccountNumber.slice(-4)}</span>}
                    </p>
                  </div>
                  <div className="ml-3 text-right">
                    {/* Statement balance — sum of all imported transactions */}
                    <p className={`text-sm font-bold font-mono ${b.balance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {fmtCurrency(b.balance)}
                    </p>
                    {/* Reconciled vs unreconciled breakdown */}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-teal-500/80 font-mono" title="Allocated to GL entries">
                        ✓ {fmtCurrency(b.reconciledBalance)}
                      </span>
                      {hasGap && (
                        <span className="text-[10px] text-amber-400 font-mono" title={`${b.unreconciledCount} unallocated transaction${b.unreconciledCount !== 1 ? 's' : ''}`}>
                          Δ {fmtCurrency(Math.abs(gap))}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
            {bank && (
              <div className="ml-auto flex items-center gap-4">
                <StatementBalanceWidget bankAccountId={selectedBank} glBalance={bank.balance} />
                <div className="text-right">
                  <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{total}</p>
                  <p className="text-xs text-[var(--ff-text-tertiary)]">
                    {tab === 'new' ? 'To be Reviewed' : tab === 'excluded' ? 'Excluded' : 'Reviewed'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-[var(--ff-border-light)]">
          <div className="flex gap-0">
            {(['new', 'reviewed', 'excluded'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === t
                    ? t === 'excluded'
                      ? 'border-red-500 text-red-400'
                      : 'border-teal-500 text-teal-400'
                    : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}>
                {t === 'new' ? 'New Transactions' : t === 'excluded' ? 'Excluded' : 'Reviewed Transactions'}
              </button>
            ))}
          </div>
        </div>

        {/* Toolbar — matches Sage: Actions | Mark Reviewed | Delete | Batch Edit | Import | Export | Search */}
        <div className="px-6 py-2 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]/30 flex items-center gap-2 flex-wrap">
          <button onClick={() => loadTransactions()} title="Refresh"
            className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <RefreshCw className="h-3.5 w-3.5" /> Actions
          </button>
          {tab === 'new' && (
            <>
              <button onClick={handleBulkAccept}
                disabled={selectedIds.size === 0}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30">
                <CheckCheck className="h-3.5 w-3.5" /> Mark as Reviewed
              </button>
              {selectedIds.size > 0 && (
                <button onClick={handleBatchAccept}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs text-teal-400 hover:text-teal-300 bg-teal-500/10 hover:bg-teal-500/20">
                  <CheckCheck className="h-3.5 w-3.5" /> Batch Allocate
                </button>
              )}
              <button onClick={handleBatchDelete}
                disabled={selectedIds.size === 0}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
              <button onClick={() => { setShowBatchEdit(!showBatchEdit); setBatchSearch(''); }}
                disabled={selectedIds.size === 0}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30">
                <Layers className="h-3.5 w-3.5" /> Batch Edit
              </button>
            </>
          )}
          <div className="border-l border-[var(--ff-border-light)] h-5 mx-1" />
          <Link href="/accounting/bank-reconciliation/import"
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <Upload className="h-3.5 w-3.5" /> Import Bank Statements
          </Link>
          <button onClick={handleExport}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <Download className="h-3.5 w-3.5" /> Export
          </button>
          {/* Quick Win 4: Apply Rules + Smart Categorize */}
          <button onClick={handleApplyRules} disabled={!selectedBank}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-yellow-500/40 text-xs text-yellow-500 hover:text-yellow-400 hover:border-yellow-400 disabled:opacity-30"
            title="Apply bank rules, then smart-categorize remaining transactions using patterns and historical data">
            <Zap className="h-3.5 w-3.5" /> Smart Categorize
          </button>
          <Link href="/accounting/bank-transactions/new"
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-teal-500/60 text-xs text-teal-400 hover:text-teal-300 hover:border-teal-400 font-medium">
            <Plus className="h-3.5 w-3.5" /> New Transaction
          </Link>
          <button onClick={handleDownloadReport} disabled={!selectedBank}
            className="flex items-center gap-1 px-2.5 py-1 rounded border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] disabled:opacity-30">
            <FileText className="h-3.5 w-3.5" /> Recon Report
          </button>
          {/* Date range filter */}
          <div className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
            <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(1); }}
              className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]" />
            <span>to</span>
            <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(1); }}
              className="px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]" />
          </div>
          {/* Amount range filter */}
          <div className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
            <span className="shrink-0">Min R</span>
            <input
              type="number"
              step="0.01"
              value={fromAmount}
              onChange={e => {
                setFromAmount(e.target.value);
                if (amountDebounceTimer.current) clearTimeout(amountDebounceTimer.current);
                amountDebounceTimer.current = setTimeout(() => setPage(1), 500);
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
                setToAmount(e.target.value);
                if (amountDebounceTimer.current) clearTimeout(amountDebounceTimer.current);
                amountDebounceTimer.current = setTimeout(() => setPage(1), 500);
              }}
              placeholder="any"
              className="w-20 px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)]"
            />
          </div>
          {/* Quick Win 2: Server-side search (debounced 500ms) */}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />
              <input type="text" placeholder="Search..." value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-7 pr-3 py-1 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] w-44" />
            </div>
            <span className="text-xs text-[var(--ff-text-tertiary)]">
              {total > 0 ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)}` : '0'} of {total}
            </span>
          </div>
        </div>

        {/* Batch Edit Panel */}
        {showBatchEdit && selectedIds.size > 0 && (
          <div className="px-6 py-3 border-b border-blue-500/30 bg-blue-500/5 flex items-center gap-3 flex-wrap">
            <span className="text-xs text-blue-400 font-medium">Batch Edit ({selectedIds.size} selected):</span>
            <select value={batchType} onChange={e => { setBatchType(e.target.value as AllocType); setBatchSearch(''); }}
              className="text-xs px-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
              <option value="account">Account</option>
              <option value="supplier">Supplier</option>
              <option value="customer">Customer</option>
            </select>
            <div className="relative">
              <input type="text" placeholder={`Search ${batchType}s...`} value={batchSearch}
                onChange={e => setBatchSearch(e.target.value)}
                className="pl-2 pr-2 py-1 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] w-52"
                autoFocus />
              <div className="absolute z-50 top-full left-0 mt-1 w-72 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl max-h-48 overflow-y-auto">
                {batchOptions.map(o => (
                  <button key={o.id} onClick={() => applyBatchEdit(o.id, o.code ? `${o.code} ${o.name}` : o.name)}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2">
                    {o.code && <span className="font-mono text-[var(--ff-text-tertiary)]">{o.code}</span>}
                    <span className="text-[var(--ff-text-primary)]">{o.name}</span>
                  </button>
                ))}
                {batchOptions.length === 0 && (
                  <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results found</div>
                )}
              </div>
            </div>
            <button onClick={() => setShowBatchEdit(false)}
              className="text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
          </div>
        )}

        {/* Rule suggestion banner — appears after allocating a transaction with similar matches */}
        {rulePrompt && (
          <div className="px-6 py-3 border-b border-yellow-500/30 bg-yellow-500/5 flex items-center gap-3 flex-wrap">
            <span className="text-xs text-yellow-400 font-medium">
              {rulePrompt.matchCount} similar transaction{rulePrompt.matchCount !== 1 ? 's' : ''} found matching
              &ldquo;{extractPattern(rulePrompt.tx.description || '')}&rdquo;.
              Create a rule to auto-categorise them?
            </span>
            <button
              onClick={() => { setCreateRuleTx(rulePrompt.tx); setRulePrompt(null); }}
              className="px-3 py-1 rounded bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-xs text-yellow-400 font-medium transition-colors"
            >
              Create Rule
            </button>
            <button
              onClick={() => setRulePrompt(null)}
              className="px-3 py-1 rounded text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Table */}
        <div className="px-4 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : transactions.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No {tab === 'new' ? 'new' : tab === 'excluded' ? 'excluded' : 'reviewed'} transactions for this account
            </div>
          ) : (
            <BankTxTable
              transactions={transactions}
              glAccounts={glAccounts}
              suppliers={suppliers}
              customers={customers}
              cc1Options={cc1Options}
              cc2Options={cc2Options}
              buOptions={buOptions}
              selectedIds={selectedIds}
              rowSelections={rowSelections}
              allSelected={allSelected}
              tab={tab}
              onToggleSelect={toggleSelect}
              onSelectAll={() => setSelectedIds(
                allSelected ? new Set() : new Set(transactions.map(t => t.id))
              )}
              onRowTypeChange={(txId, type) => {
                // VAT only applies to GL account allocations; supplier/customer VAT is handled on their invoices
                const vatCode = type === 'account' ? (rowSelections[txId]?.vatCode || 'none') : 'none';
                setRowSelections(prev => ({ ...prev, [txId]: { type, entityId: '', label: '', vatCode } }));
                saveSelection(txId, type, '');
              }}
              onRowEntityChange={(txId, entityId, label) => {
                const type = rowSelections[txId]?.type || 'account';
                let vatCode = (rowSelections[txId]?.vatCode || 'none') as VatCode;
                if (type === 'account' && entityId) {
                  const acct = glAccounts.find(g => g.id === entityId);
                  if (acct?.defaultVatCode && acct.defaultVatCode !== 'none') {
                    vatCode = acct.defaultVatCode as VatCode;
                  }
                }
                setRowSelections(prev => ({
                  ...prev,
                  [txId]: { ...prev[txId], type, entityId, label, vatCode },
                }));
                saveSelection(txId, type as AllocType, entityId, vatCode);
              }}
              onRowVatChange={(txId, vatCode) => {
                setRowSelections(prev => ({
                  ...prev,
                  [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode },
                }));
                const sel = rowSelections[txId];
                if (sel?.entityId) saveSelection(txId, sel.type, sel.entityId, vatCode);
              }
              }
              onRowDimensionChange={(txId, cc1Id, cc2Id, buId) => {
                setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode: prev[txId]?.vatCode || 'none', cc1Id: cc1Id || undefined, cc2Id: cc2Id || undefined, buId: buId || undefined } }));
                saveDimensions(txId, cc1Id, cc2Id, buId);
              }}
              onAccept={handleAccept}
              onExclude={handleExclude}
              onUnmatch={handleUnmatch}
              onSplit={handleSplit}
              onUpdateNotes={handleUpdateNotes}
              onFindMatch={(txId) => setFindMatchTxId(txId)}
              onReverse={handleReverse}
              onAttachments={(txId) => setAttachmentsTxId(txId)}
              onCreateRule={(tx) => setCreateRuleTx(tx)}
              onCreateEntity={(txId, type) => { setCreateEntityTxId(txId); setCreateEntityType(type); }}
            />
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-3 border-t border-[var(--ff-border-light)] flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button disabled={page <= 1} onClick={() => setPage(1)}
                className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">First</button>
              {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
                const p = totalPages <= 10 ? i + 1
                  : page <= 5 ? i + 1
                  : page >= totalPages - 4 ? totalPages - 9 + i
                  : page - 5 + i;
                return (
                  <button key={p} onClick={() => setPage(p)}
                    className={`w-7 h-7 rounded text-xs ${
                      p === page ? 'bg-teal-600 text-white font-bold'
                        : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'
                    }`}>{p}</button>
                );
              })}
              <button disabled={page >= totalPages} onClick={() => setPage(totalPages)}
                className="px-3 py-2 rounded text-xs text-[var(--ff-text-secondary)] disabled:opacity-30">Last</button>
            </div>
            <span className="text-xs text-[var(--ff-text-tertiary)]">
              Displaying {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
          </div>
        )}

        {/* Bottom bar — Sage-style: Mark Selected as Reviewed */}
        {tab === 'new' && transactions.length > 0 && (
          <div className="sticky bottom-0 bg-[var(--ff-bg-secondary)] border-t border-[var(--ff-border-light)] px-6 py-3 flex items-center justify-center gap-4">
            <button onClick={handleBulkAccept}
              disabled={selectedIds.size === 0}
              className="px-5 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              Mark Selected as Reviewed ({selectedIds.size})
            </button>
          </div>
        )}
      </div>
      {/* Split Transaction Modal */}
      {splitTxId && (() => {
        const splitTx = transactions.find(t => t.id === splitTxId);
        if (!splitTx) return null;
        return (
          <SplitTransactionModal
            transaction={splitTx}
            glAccounts={glAccounts}
            onClose={() => setSplitTxId(null)}
            onSplit={() => {
              setSplitTxId(null);
              loadTransactions();
            }}
          />
        );
      })()}
      {/* Exclude Reason Modal */}
      {excludingTxId && (() => {
        const excludeTx = transactions.find(t => t.id === excludingTxId);
        if (!excludeTx) return null;
        return (
          <ExcludeReasonModal
            transaction={excludeTx}
            onClose={() => setExcludingTxId(null)}
            onExclude={(reason) => handleExcludeConfirm(reason)}
          />
        );
      })()}
      {/* Find & Match Modal */}
      {findMatchTxId && (() => {
        const matchTx = transactions.find(t => t.id === findMatchTxId);
        if (!matchTx) return null;
        return (
          <FindMatchModal
            transaction={{ id: matchTx.id, description: matchTx.description || '', amount: matchTx.amount, transactionDate: matchTx.transactionDate }}
            onClose={() => setFindMatchTxId(null)}
            onMatch={() => { setFindMatchTxId(null); loadTransactions(); }}
          />
        );
      })()}
      {/* Attachments Modal */}
      {attachmentsTxId && (
        <BankTxAttachmentsModal
          bankTransactionId={attachmentsTxId}
          transactionDescription={transactions.find(t => t.id === attachmentsTxId)?.description}
          onClose={() => setAttachmentsTxId(null)}
        />
      )}
      {/* Create Rule Modal */}
      {createRuleTx && (
        <CreateRuleModal
          transaction={createRuleTx}
          bankAccountId={selectedBank}
          glAccounts={glAccounts}
          suppliers={suppliers}
          clients={customers}
          onClose={() => setCreateRuleTx(null)}
          onCreated={() => {
            setCreateRuleTx(null);
            notify.success('Rule created — click "Apply Rules" to categorise matching transactions');
            loadTransactions();
          }}
        />
      )}
      {/* Create Entity Modal (GL Account / Supplier / Customer) */}
      {createEntityTxId && createEntityType && (
        <CreateEntityModal
          type={createEntityType}
          transactionDescription={transactions.find(t => t.id === createEntityTxId)?.description}
          existingAccounts={glAccounts}
          onClose={() => { setCreateEntityTxId(null); setCreateEntityType(null); }}
          onCreated={(entity) => {
            const label = entity.code ? `${entity.code} ${entity.name}` : entity.name;
            const option: SelectOption = { id: entity.id, code: entity.code, name: entity.name };
            if (createEntityType === 'account') {
              setGlAccounts(prev => [...prev, option].sort((a, b) => (a.code || '').localeCompare(b.code || '')));
            } else if (createEntityType === 'supplier') {
              setSuppliers(prev => [...prev, option]);
            } else {
              setCustomers(prev => [...prev, option]);
            }
            setRowSelections(prev => ({
              ...prev,
              [createEntityTxId]: {
                type: createEntityType,
                entityId: entity.id,
                label,
                vatCode: prev[createEntityTxId]?.vatCode || 'none',
              },
            }));
            setCreateEntityTxId(null);
            setCreateEntityType(null);
          }}
        />
      )}
    </AppLayout>
  );
}
