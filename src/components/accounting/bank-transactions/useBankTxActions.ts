/**
 * useBankTxActions — All server-mutating action handlers for the bank transactions page.
 * Keeps the page shell thin by co-locating callAction, saveSelection, saveDimensions,
 * and all derived handler functions.
 */

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { extractPattern } from '@/components/accounting/CreateRuleModal';
import type { AllocType, VatCode, BankTx, SelectOption, RowSelection } from '@/components/accounting/BankTxTable';
import type { RulePrompt } from './BankTxBatchPanel';

interface ActionDeps {
  transactions: BankTx[];
  glAccounts: SelectOption[];
  selectedBank: string;
  selectedIds: Set<string>;
  rowSelections: Record<string, RowSelection>;
  batchType: AllocType;
  excludingTxId: string | null;
  createEntityTxId: string | null;
  setSmartRunning: (v: boolean) => void;
  setRowSelections: (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void;
  setTransactions: (fn: (prev: BankTx[]) => BankTx[]) => void;
  setSelectedIds: (fn: (prev: Set<string>) => Set<string>) => void;
  setShowBatchEdit: (v: boolean) => void;
  setRulePrompt: (v: RulePrompt | null) => void;
  setExcludingTxId: (v: string | null) => void;
  loadTransactions: () => void;
}

export function buildBankTxActions(deps: ActionDeps) {
  const {
    transactions, glAccounts, selectedBank, selectedIds, rowSelections, batchType,
    excludingTxId, createEntityTxId,
    setSmartRunning, setRowSelections, setTransactions, setSelectedIds, setShowBatchEdit,
    setRulePrompt, setExcludingTxId, loadTransactions,
  } = deps;

  const callAction = async (body: Record<string, string>) => {
    const res = await apiFetch('/api/accounting/bank-transactions-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
      throw new Error(json.error?.message || json.message || (typeof json.error === 'string' ? json.error : 'Action failed'));
    }
    return json;
  };

  const saveSelection = (txId: string, type: AllocType, entityId: string, vatCode?: string) => {
    apiFetch('/api/accounting/bank-transactions-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'save_selection', bankTransactionId: txId, selectionType: type, selectionEntityId: entityId || null, vatCode: vatCode || null }),
    }).catch(() => { notify.error('Failed to save selection — please try again'); });
  };

  const saveDimensions = (txId: string, cc1Id: string, cc2Id: string, buId: string) => {
    apiFetch('/api/accounting/bank-transactions-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'save_dimensions', bankTransactionId: txId, cc1Id: cc1Id || null, cc2Id: cc2Id || null, buId: buId || null }),
    }).catch(() => { /* fire-and-forget */ });
  };

  const handleAccept = async (txId: string) => {
    const sel = rowSelections[txId];
    if (!sel?.entityId) { notify.error('Select an account/supplier/customer first'); return; }
    const tx = transactions.find(t => t.id === txId);
    try {
      const body: Record<string, string> = { action: 'allocate', bankTransactionId: txId, allocationType: sel.type, vatCode: sel.vatCode || 'none' };
      if (sel.type === 'account') body.contraAccountId = sel.entityId; else body.entityId = sel.entityId;
      if (sel.cc1Id) body.cc1Id = sel.cc1Id;
      if (sel.cc2Id) body.cc2Id = sel.cc2Id;
      if (sel.buId) body.buId = sel.buId;
      await callAction(body);
      notify.success('Transaction allocated');
      loadTransactions();
      if (sel.type === 'account' && sel.entityId) {
        apiFetch('/api/accounting/smart-categorize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'learn', txId, glAccountId: sel.entityId, category: sel.label, vatCode: sel.vatCode }),
        }).catch(() => { /* fire-and-forget */ });
      }
      if (tx?.description && selectedBank) {
        const pattern = extractPattern(tx.description);
        if (pattern.trim().length >= 3) {
          try {
            const params = new URLSearchParams({ pattern, matchType: 'contains', bankAccountId: selectedBank });
            const res = await apiFetch(`/api/accounting/bank-rules-preview?${params}`);
            const json = await res.json();
            const matchCount = json.data?.matchCount ?? 0;
            if (matchCount > 0) setRulePrompt({ tx, matchCount });
          } catch { /* non-critical */ }
        }
      }
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed'); }
  };

  const handleExclude = (txId: string) => setExcludingTxId(txId);
  const handleExcludeConfirm = async (reason: string) => {
    if (!excludingTxId) return;
    const txId = excludingTxId;
    setExcludingTxId(null);
    try {
      await callAction({ action: 'exclude', bankTransactionId: txId, excludeReason: reason });
      notify.success('Transaction excluded'); loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to exclude'); }
  };
  const handleUnmatch = async (txId: string) => {
    try { await callAction({ action: 'unmatch', bankTransactionId: txId }); notify.success('Allocation undone'); loadTransactions(); }
    catch (e) { notify.error(e instanceof Error ? e.message : 'Failed'); }
  };
  const handleUpdateNotes = async (txId: string, notes: string) => {
    setTransactions(prev => prev.map(tx => tx.id === txId ? { ...tx, notes: notes || undefined } : tx));
    try {
      const res = await apiFetch('/api/accounting/bank-transactions-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'update_notes', bankTransactionId: txId, notes }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || 'Failed to save note');
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to save note'); loadTransactions(); }
  };
  const handleBatchAccept = async () => {
    const toAccept = Array.from(selectedIds).filter(id => rowSelections[id]?.entityId);
    if (toAccept.length === 0) { notify.error('Select transactions with accounts assigned'); return; }
    let ok = 0, fail = 0;
    for (const txId of toAccept) {
      try {
        const sel = rowSelections[txId];
        if (!sel) continue;
        const body: Record<string, string> = { action: 'allocate', bankTransactionId: txId, allocationType: sel.type, vatCode: sel.vatCode || 'none' };
        if (sel.type === 'account') body.contraAccountId = sel.entityId; else body.entityId = sel.entityId;
        if (sel.cc1Id) body.cc1Id = sel.cc1Id;
        if (sel.cc2Id) body.cc2Id = sel.cc2Id;
        if (sel.buId) body.buId = sel.buId;
        await callAction(body); ok++;
      } catch { fail++; }
    }
    notify.success(`${ok} allocated${fail ? `, ${fail} failed` : ''}`); setSelectedIds(() => new Set()); loadTransactions();
  };
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} transaction(s)? This cannot be undone.`)) return;
    try {
      await callAction({ action: 'delete', bankTransactionIds: Array.from(selectedIds) } as unknown as Record<string, string>);
      notify.success(`${selectedIds.size} transaction(s) deleted`);
      setSelectedIds(() => new Set()); loadTransactions();
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
      setSelectedIds(() => new Set()); loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to mark as reviewed'); }
  };
  const handleApplyRules = async () => {
    if (!selectedBank) { notify.error('Select a bank account first'); return; }
    setSmartRunning(true);
    notify.success('Running smart categorization...');
    try {
      const rulesRes = await apiFetch('/api/accounting/bank-rules-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'apply', bankAccountId: selectedBank }),
      });
      const rulesJson = await rulesRes.json();
      if (!rulesRes.ok || rulesJson.success === false) throw new Error(rulesJson.message || 'Apply rules failed');
      const rulesApplied = rulesJson.data?.applied ?? 0;
      let smartCategorized = 0, totalSkipped = 0;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const smartRes = await apiFetch('/api/accounting/smart-categorize', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'categorize', bankAccountId: selectedBank }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const smartJson = await smartRes.json();
        smartCategorized = smartJson.data?.categorized ?? 0;
        totalSkipped = smartJson.data?.skipped ?? 0;
      } catch { /* AI categorization timed out */ }
      notify.success(rulesApplied + smartCategorized > 0
        ? `${rulesApplied} rules applied, ${smartCategorized} smart-categorised, ${totalSkipped} skipped`
        : 'No new categorisations found');
      setRowSelections(() => ({})); loadTransactions();
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Failed to apply rules'); }
    finally { setSmartRunning(false); }
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
  const handleExport = (bankAccountCode: string | undefined) => {
    const rows = transactions.map(tx => ({
      Date: tx.transactionDate, Description: tx.description || '', Reference: tx.reference || '',
      Spent: tx.amount < 0 ? Math.abs(tx.amount) : '', Received: tx.amount > 0 ? tx.amount : '',
      Status: tx.status,
    }));
    const header = Object.keys(rows[0] || {}).join(',');
    const csv = [header, ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bank-transactions-${bankAccountCode || 'export'}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };
  const handleDownloadReport = async (bankAccountCode: string | undefined) => {
    if (!selectedBank) return;
    try {
      const res = await apiFetch(`/api/accounting/bank-reconciliation-report?bankAccountId=${selectedBank}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      const { generateReconReport } = await import('@/modules/accounting/utils/reconReportPdf');
      const blob = await generateReconReport(json.data || json);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `recon-report-${bankAccountCode || 'bank'}.pdf`;
      a.click(); URL.revokeObjectURL(url);
      notify.success('Report downloaded');
    } catch (e) { notify.error(e instanceof Error ? e.message : 'Report failed'); }
  };
  const handleApplyBatchEdit = (entityId: string, label: string) => {
    const updates: Record<string, RowSelection> = { ...rowSelections };
    const acct = batchType === 'account' ? glAccounts.find(g => g.id === entityId) : null;
    const autoVat = acct?.defaultVatCode && acct.defaultVatCode !== 'none' ? acct.defaultVatCode as VatCode : undefined;
    selectedIds.forEach(id => {
      updates[id] = { type: batchType, entityId, label, vatCode: autoVat ?? (updates[id]?.vatCode || 'none') as VatCode };
    });
    setRowSelections(() => updates);
    setShowBatchEdit(false);
    notify.success(`Applied ${batchType} "${label}" to ${selectedIds.size} rows`);
  };
  // ---- Row-level selection handlers (also persist to DB) ----
  const handleRowTypeChange = (txId: string, type: AllocType) => {
    setRowSelections(prev => ({ ...prev, [txId]: { type, entityId: '', label: '', vatCode: type === 'account' ? (prev[txId]?.vatCode || 'none') : 'none' } }));
    saveSelection(txId, type, '');
  };
  const handleRowEntityChange = (txId: string, entityId: string, label: string) => {
    const type = rowSelections[txId]?.type || 'account';
    const acct = type === 'account' && entityId ? glAccounts.find(g => g.id === entityId) : null;
    const vatCode = (acct?.defaultVatCode && acct.defaultVatCode !== 'none' ? acct.defaultVatCode : (rowSelections[txId]?.vatCode || 'none')) as VatCode;
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type, entityId, label, vatCode } }));
    saveSelection(txId, type as AllocType, entityId, vatCode);
  };
  const handleRowVatChange = (txId: string, vatCode: VatCode) => {
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode } }));
    const sel = rowSelections[txId];
    if (sel?.entityId) saveSelection(txId, sel.type, sel.entityId, vatCode);
  };
  const handleRowDimensionChange = (txId: string, cc1Id: string, cc2Id: string, buId: string) => {
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode: prev[txId]?.vatCode || 'none', cc1Id: cc1Id || undefined, cc2Id: cc2Id || undefined, buId: buId || undefined } }));
    saveDimensions(txId, cc1Id, cc2Id, buId);
  };
  const handleCreateEntityDone = (
    entity: { id: string; name: string; code?: string },
    type: AllocType,
    setGlAccounts: (fn: (prev: SelectOption[]) => SelectOption[]) => void,
    setSuppliers: (fn: (prev: SelectOption[]) => SelectOption[]) => void,
    setCustomers: (fn: (prev: SelectOption[]) => SelectOption[]) => void,
  ) => {
    const label = entity.code ? `${entity.code} ${entity.name}` : entity.name;
    const option: SelectOption = { id: entity.id, code: entity.code, name: entity.name };
    if (type === 'account') setGlAccounts(prev => [...prev, option].sort((a, b) => (a.code || '').localeCompare(b.code || '')));
    else if (type === 'supplier') setSuppliers(prev => [...prev, option]);
    else setCustomers(prev => [...prev, option]);
    const vatCode = (type === 'account' && entity.id)
      ? (glAccounts.find(g => g.id === entity.id)?.defaultVatCode as VatCode || 'none')
      : 'none';
    if (createEntityTxId) {
      setRowSelections(prev => ({ ...prev, [createEntityTxId]: { type, entityId: entity.id, label, vatCode: prev[createEntityTxId]?.vatCode || vatCode } }));
      saveSelection(createEntityTxId, type as AllocType, entity.id, vatCode);
    }
  };
  return {
    saveSelection, saveDimensions,
    handleAccept, handleExclude, handleExcludeConfirm, handleUnmatch, handleUpdateNotes,
    handleBatchAccept, handleBatchDelete, handleBulkAccept, handleApplyRules, handleReverse,
    handleExport, handleDownloadReport, handleCreateEntityDone, handleApplyBatchEdit,
    handleRowTypeChange, handleRowEntityChange, handleRowVatChange, handleRowDimensionChange,
  };
}
