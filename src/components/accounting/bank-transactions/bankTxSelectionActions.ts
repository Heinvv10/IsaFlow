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

/** The newest edit made to each field group of each row: a refused save rolls back only if it is still the latest. */
const editSeq = new Map<string, number>();
const claimEdit = (txId: string, group: Group): number => { const n = (editSeq.get(`${txId}:${group}`) ?? 0) + 1; editSeq.set(`${txId}:${group}`, n); return n; };
const DIM_KEYS = ['cc1Id', 'cc2Id', 'buId'] as const;
type Group = 'alloc' | 'dims';
const groupOf = (k: keyof RowSelection): Group => ((DIM_KEYS as readonly string[]).includes(k) ? 'dims' : 'alloc');
/** What a field is when the row had no selection before the edit. */
const EMPTY: Partial<RowSelection> = { type: 'account', entityId: '', label: '', vatCode: 'none' };

export function buildBankTxSelectionActions(
  deps: SelectionDeps,
  saveSelection: (txId: string, type: AllocType, entityId: string, vatCode?: string, onFailure?: () => void, silent?: boolean) => Promise<boolean> | void,
  saveDimensions: (txId: string, cc1Id: string, cc2Id: string, buId: string, onFailure?: () => void) => void,
) {
  const { glAccounts, selectedIds, rowSelections, batchType, createEntityTxId, setRowSelections, setShowBatchEdit } = deps;

  /** An edit that REPLACES the row (type change, Batch Edit, a new entity) drops its cost centres; a refused save must bring them back. */
  const NO_DIMS = { cc1Id: undefined, cc2Id: undefined, buId: undefined };

  /**
   * Puts the fields an edit changed back to what they were, for a save the server refused. Per field GROUP (the allocation:
   * type, entity, label, VAT; the cost centres), and only for a group where this is still the LATEST edit (a per-edit sequence
   * id, so re-picking the same value later does not make an old, late failure look current) and the row still shows the
   * edit's values. An edit to one group never blocks or reverts the other. A row that had no selection before goes back to
   * none, and is removed once nothing is set on it.
   */
  const rollbackRow = (txId: string, before: RowSelection | undefined, patch: Partial<RowSelection>) => {
    const keys = Object.keys(patch) as Array<keyof RowSelection>;
    const seqs = new Map<Group, number>();
    for (const k of keys) { const g = groupOf(k); if (!seqs.has(g)) seqs.set(g, claimEdit(txId, g)); }
    return () => setRowSelections(prev => {
      const cur = prev[txId];
      if (!cur) return prev;
      const restore = keys.filter(k => editSeq.get(`${txId}:${groupOf(k)}`) === seqs.get(groupOf(k))
        && keys.filter(o => groupOf(o) === groupOf(k)).every(o => cur[o] === patch[o]));
      if (restore.length === 0) return prev;
      const row: RowSelection = { ...cur };
      for (const k of restore) (row as unknown as Record<string, unknown>)[k] = before ? before[k] : EMPTY[k];
      const next = { ...prev };
      if (!before && !row.entityId && !DIM_KEYS.some(k => row[k])) delete next[txId];
      else next[txId] = row;
      return next;
    });
  };

  const handleApplyBatchEdit = (entityId: string, label: string) => {
    const updates: Record<string, RowSelection> = { ...rowSelections };
    const saves: Array<Promise<boolean | void>> = [];
    const acct = batchType === 'account' ? glAccounts.find(g => g.id === entityId) : null;
    const autoVat = acct?.defaultVatCode && acct.defaultVatCode !== 'none' ? acct.defaultVatCode as VatCode : undefined;
    selectedIds.forEach(id => {
      updates[id] = { type: batchType, entityId, label, vatCode: batchType === 'account' ? (autoVat ?? (updates[id]?.vatCode || 'none') as VatCode) : 'none' }; // a settlement carries no VAT: switching type resets it, as the single-row change does
      // Persisted like a single-row edit (it used to live only in the page: a reload lost it); a refused save restores that row.
      const patch = { type: batchType, entityId, label, vatCode: updates[id]!.vatCode, ...NO_DIMS };
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
    setRowSelections(prev => ({ ...prev, [txId]: { type, entityId: '', label: '', vatCode } })); void saveSelection(txId, type, '', vatCode, rollbackRow(txId, rowSelections[txId], { type, entityId: '', label: '', vatCode, ...NO_DIMS }));
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
      void saveSelection(createEntityTxId, type as AllocType, entity.id, vatCode, rollbackRow(createEntityTxId, rowSelections[createEntityTxId], { type, entityId: entity.id, label, vatCode: rowSelections[createEntityTxId]?.vatCode || vatCode, ...NO_DIMS }));
    }
  };
  return {
    handleCreateEntityDone, handleApplyBatchEdit,
    handleRowTypeChange, handleRowEntityChange, handleRowVatChange, handleRowDimensionChange,
  };
}
