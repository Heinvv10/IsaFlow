/**
 * bankTxSelectionActions — the row-level selection handlers of the bank transactions page: what each row is
 * allocated to before it is accepted. None of them posts; they persist the choice through saveSelection and
 * saveDimensions. Split out of useBankTxActions (300-line rule).
 */

import { notify } from '@/utils/toast';
import type { AllocType, VatCode, SelectOption, RowSelection } from '@/components/accounting/BankTxTable';

interface SelectionDeps {
  glAccounts: SelectOption[];
  selectedIds: Set<string>;
  rowSelections: Record<string, RowSelection>;
  batchType: AllocType;
  createEntityTxId: string | null;
  setRowSelections: (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void;
  setShowBatchEdit: (v: boolean) => void;
}

export function buildBankTxSelectionActions(
  deps: SelectionDeps,
  saveSelection: (txId: string, type: AllocType, entityId: string, vatCode?: string, onFailure?: () => void) => void,
  saveDimensions: (txId: string, cc1Id: string, cc2Id: string, buId: string, onFailure?: () => void) => void,
) {
  const { glAccounts, selectedIds, rowSelections, batchType, createEntityTxId, setRowSelections, setShowBatchEdit } = deps;

  /** Puts one row's selection back as it was, or removes it if it had none: for a save the server refused. */
  const rollbackRow = (txId: string, before: RowSelection | undefined) => () =>
    setRowSelections(prev => { const next = { ...prev }; if (before) next[txId] = before; else delete next[txId]; return next; });

  const handleApplyBatchEdit = (entityId: string, label: string) => {
    const updates: Record<string, RowSelection> = { ...rowSelections };
    const acct = batchType === 'account' ? glAccounts.find(g => g.id === entityId) : null;
    const autoVat = acct?.defaultVatCode && acct.defaultVatCode !== 'none' ? acct.defaultVatCode as VatCode : undefined;
    selectedIds.forEach(id => {
      updates[id] = { type: batchType, entityId, label, vatCode: autoVat ?? (updates[id]?.vatCode || 'none') as VatCode };
      // Persisted like a single-row edit (it used to live only in the page: a reload lost it); a refused save restores that row.
      saveSelection(id, batchType, entityId, updates[id]!.vatCode, rollbackRow(id, rowSelections[id]));
    });
    setRowSelections(() => updates);
    setShowBatchEdit(false);
    notify.success(`Applied ${batchType} "${label}" to ${selectedIds.size} rows`);
  };
  // ---- Row-level selection handlers (also persist to DB) ----
  const handleRowTypeChange = (txId: string, type: AllocType) => {
    const vatCode: VatCode = type === 'account' ? (rowSelections[txId]?.vatCode || 'none') : 'none';
    setRowSelections(prev => ({ ...prev, [txId]: { type, entityId: '', label: '', vatCode } })); saveSelection(txId, type, '', vatCode, rollbackRow(txId, rowSelections[txId]));
  };
  const handleRowEntityChange = (txId: string, entityId: string, label: string) => {
    const type = rowSelections[txId]?.type || 'account';
    const acct = type === 'account' && entityId ? glAccounts.find(g => g.id === entityId) : null;
    // An account flagged vat_input_denied still only DEFAULTS to none — the
    // table warns and the user may override. Its default_vat_code is what
    // decides the starting value, exactly as for any other account.
    const vatCode = (acct?.defaultVatCode === 'none' ? 'none'
      : acct?.defaultVatCode ? acct.defaultVatCode
      : (rowSelections[txId]?.vatCode || 'none')) as VatCode;
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type, entityId, label, vatCode } }));
    saveSelection(txId, type as AllocType, entityId, vatCode, rollbackRow(txId, rowSelections[txId]));
  };
  const handleRowVatChange = (txId: string, vatCode: VatCode) => {
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode } }));
    const sel = rowSelections[txId];
    if (sel?.entityId) saveSelection(txId, sel.type, sel.entityId, vatCode, rollbackRow(txId, rowSelections[txId]));
  };
  const handleRowDimensionChange = (txId: string, cc1Id: string, cc2Id: string, buId: string) => {
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode: prev[txId]?.vatCode || 'none', cc1Id: cc1Id || undefined, cc2Id: cc2Id || undefined, buId: buId || undefined } }));
    saveDimensions(txId, cc1Id, cc2Id, buId, rollbackRow(txId, rowSelections[txId]));
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
      saveSelection(createEntityTxId, type as AllocType, entity.id, vatCode, rollbackRow(createEntityTxId, rowSelections[createEntityTxId]));
    }
  };
  return {
    handleCreateEntityDone, handleApplyBatchEdit,
    handleRowTypeChange, handleRowEntityChange, handleRowVatChange, handleRowDimensionChange,
  };
}
