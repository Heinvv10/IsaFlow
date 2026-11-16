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
  saveSelection: (txId: string, type: AllocType, entityId: string, vatCode?: string, onFailure?: () => void, silent?: boolean) => Promise<boolean> | void,
  saveDimensions: (txId: string, cc1Id: string, cc2Id: string, buId: string, onFailure?: () => void) => void,
) {
  const { glAccounts, selectedIds, rowSelections, batchType, createEntityTxId, setRowSelections, setShowBatchEdit } = deps;

  /**
   * Puts the fields an edit changed back to what they were, for a save the server refused, but ONLY while the row still
   * shows that edit's value: if a later edit (or its success) has since changed those fields, the stale snapshot must not
   * overwrite it. A row that had no selection before is removed (when it still shows exactly this edit).
   */
  const rollbackRow = (txId: string, before: RowSelection | undefined, patch: Partial<RowSelection>) => () =>
    setRowSelections(prev => {
      const cur = prev[txId];
      const keys = Object.keys(patch) as Array<keyof RowSelection>;
      if (!cur || keys.some(k => cur[k] !== patch[k])) return prev;
      const next = { ...prev };
      if (!before) delete next[txId];
      else next[txId] = { ...cur, ...Object.fromEntries(keys.map(k => [k, before[k]])) };
      return next;
    });

  const handleApplyBatchEdit = (entityId: string, label: string) => {
    const updates: Record<string, RowSelection> = { ...rowSelections };
    const saves: Array<Promise<boolean | void>> = [];
    const acct = batchType === 'account' ? glAccounts.find(g => g.id === entityId) : null;
    const autoVat = acct?.defaultVatCode && acct.defaultVatCode !== 'none' ? acct.defaultVatCode as VatCode : undefined;
    selectedIds.forEach(id => {
      updates[id] = { type: batchType, entityId, label, vatCode: autoVat ?? (updates[id]?.vatCode || 'none') as VatCode };
      // Persisted like a single-row edit (it used to live only in the page: a reload lost it); a refused save restores that row.
      const patch = { type: batchType, entityId, label, vatCode: updates[id]!.vatCode };
      saves.push(Promise.resolve(saveSelection(id, batchType, entityId, patch.vatCode, rollbackRow(id, rowSelections[id], patch), true)));
    });
    setRowSelections(() => updates);
    setShowBatchEdit(false);
    notify.success(`Applied ${batchType} "${label}" to ${selectedIds.size} rows`);
    // One report for the whole batch, not one toast per refused row.
    void Promise.all(saves).then(results => {
      const failed = results.filter(r => r === false).length;
      if (failed > 0) notify.error(`${failed} of ${saves.length} rows could not be saved`, 'Their previous allocation was put back.');
    });
  };
  // ---- Row-level selection handlers (also persist to DB) ----
  const handleRowTypeChange = (txId: string, type: AllocType) => {
    const vatCode: VatCode = type === 'account' ? (rowSelections[txId]?.vatCode || 'none') : 'none';
    setRowSelections(prev => ({ ...prev, [txId]: { type, entityId: '', label: '', vatCode } })); void saveSelection(txId, type, '', vatCode, rollbackRow(txId, rowSelections[txId], { type, entityId: '', label: '', vatCode }));
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
    void saveSelection(txId, type as AllocType, entityId, vatCode, rollbackRow(txId, rowSelections[txId], { type, entityId, label, vatCode }));
  };
  const handleRowVatChange = (txId: string, vatCode: VatCode) => {
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode } }));
    const sel = rowSelections[txId];
    if (sel?.entityId) void saveSelection(txId, sel.type, sel.entityId, vatCode, rollbackRow(txId, sel, { vatCode }));
  };
  const handleRowDimensionChange = (txId: string, cc1Id: string, cc2Id: string, buId: string) => {
    setRowSelections(prev => ({ ...prev, [txId]: { ...prev[txId], type: prev[txId]?.type || 'account', entityId: prev[txId]?.entityId || '', label: prev[txId]?.label || '', vatCode: prev[txId]?.vatCode || 'none', cc1Id: cc1Id || undefined, cc2Id: cc2Id || undefined, buId: buId || undefined } }));
    saveDimensions(txId, cc1Id, cc2Id, buId, rollbackRow(txId, rowSelections[txId], { cc1Id: cc1Id || undefined, cc2Id: cc2Id || undefined, buId: buId || undefined }));
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
      void saveSelection(createEntityTxId, type as AllocType, entity.id, vatCode, rollbackRow(createEntityTxId, rowSelections[createEntityTxId], { type, entityId: entity.id, label, vatCode: rowSelections[createEntityTxId]?.vatCode || vatCode }));
    }
  };
  return {
    handleCreateEntityDone, handleApplyBatchEdit,
    handleRowTypeChange, handleRowEntityChange, handleRowVatChange, handleRowDimensionChange,
  };
}
