/**
 * Sage-style bank transaction table with inline allocation
 * Type selector: Account / Supplier / Customer — Selection dropdown changes accordingly
 * VAT selector: No VAT / Standard 15% / Zero-Rated / Exempt
 * Notes: inline-editable per row, saved on blur
 */

import { useState, useRef, useEffect } from 'react';
import { Check, X, Undo2, Search, Scissors, SearchCheck, RotateCcw, Paperclip, BookmarkPlus, Plus } from 'lucide-react';

export type AllocType = 'account' | 'supplier' | 'customer';
export type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

export const VAT_OPTIONS: { value: VatCode; label: string; rate: number }[] = [
  { value: 'none', label: 'No VAT', rate: 0 },
  { value: 'standard', label: 'Standard 15%', rate: 15 },
  { value: 'zero_rated', label: 'Zero Rated', rate: 0 },
  { value: 'exempt', label: 'Exempt', rate: 0 },
];

export interface BankTx {
  id: string;
  transactionDate: string;
  description?: string;
  reference?: string;
  bankReference?: string;
  amount: number;
  status: string;
  /** Reason recorded when this transaction was excluded */
  excludeReason?: string;
  /** User-editable memo field from bank_transactions.notes */
  notes?: string;
  /** Suggestion fields — populated by rules or classified import */
  suggestedGlAccountId?: string;
  suggestedGlAccountName?: string;
  suggestedGlAccountCode?: string;
  suggestedSupplierId?: string;
  suggestedSupplierName?: string;
  suggestedClientId?: string;
  suggestedClientName?: string;
  suggestedCategory?: string;
  suggestedVatCode?: string;
  /** Dimension fields */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  cc1Name?: string;
  cc2Name?: string;
  buName?: string;
  /** Allocation tracking — populated for matched/reconciled transactions */
  allocationType?: AllocType;
  allocatedEntityName?: string;
}

export interface SelectOption {
  id: string;
  code?: string;
  name: string;
  defaultVatCode?: string;
}

export interface RowSelection {
  type: AllocType;
  entityId: string;
  label: string;
  vatCode: VatCode;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

interface Props {
  transactions: BankTx[];
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  cc1Options: SelectOption[];
  cc2Options: SelectOption[];
  buOptions: SelectOption[];
  selectedIds: Set<string>;
  rowSelections: Record<string, RowSelection>;
  allSelected: boolean;
  tab: 'new' | 'reviewed' | 'excluded';
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onRowTypeChange: (txId: string, type: AllocType) => void;
  onRowEntityChange: (txId: string, entityId: string, label: string) => void;
  onRowVatChange: (txId: string, vatCode: VatCode) => void;
  onRowDimensionChange: (txId: string, cc1Id: string, cc2Id: string, buId: string) => void;
  onAccept: (txId: string) => void;
  onExclude: (txId: string) => void;
  onUnmatch: (txId: string) => void;
  onSplit: (txId: string) => void;
  /** Called when the user finishes editing the notes field for a row */
  onUpdateNotes?: (txId: string, notes: string) => void;
  onFindMatch?: (txId: string) => void;
  onReverse?: (txId: string) => void;
  onAttachments?: (txId: string) => void;
  onCreateRule?: (tx: BankTx) => void;
  onCreateEntity?: (txId: string, type: AllocType) => void;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

/**
 * Inline-editable notes cell.
 * Renders as gray placeholder text when empty, saves on blur.
 */
function NotesCell({
  txId, initialValue, onSave,
}: {
  txId: string;
  initialValue: string;
  onSave: (txId: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep local value in sync if parent reloads transactions
  useEffect(() => { setValue(initialValue); }, [initialValue]);

  function handleBlur() {
    setEditing(false);
    if (value !== initialValue) {
      onSave(txId, value);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={e => { if (e.key === 'Enter') inputRef.current?.blur(); if (e.key === 'Escape') { setValue(initialValue); setEditing(false); } }}
        className="w-full px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-blue-500/60 text-xs text-[var(--ff-text-primary)] focus:outline-none"
        placeholder="Add note..."
        autoFocus
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="text-xs truncate max-w-[140px] block text-left hover:text-[var(--ff-text-primary)] transition-colors"
      title={value || 'Click to add note'}
    >
      {value
        ? <span className="text-[var(--ff-text-secondary)]">{value}</span>
        : <span className="text-[var(--ff-text-tertiary)] italic">Add note...</span>
      }
    </button>
  );
}

export function BankTxTable(props: Props) {
  const {
    transactions, glAccounts, suppliers, customers,
    cc1Options, cc2Options, buOptions,
    selectedIds, rowSelections, allSelected, tab,
    onToggleSelect, onSelectAll, onRowTypeChange, onRowEntityChange, onRowVatChange,
    onRowDimensionChange,
    onAccept, onExclude, onUnmatch, onSplit, onUpdateNotes,
    onFindMatch, onReverse, onAttachments, onCreateRule, onCreateEntity,
  } = props;
  const [openSel, setOpenSel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside it (data-attribute approach for multi-row support)
  useEffect(() => {
    if (!openSel) return;
    const h = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-bank-dropdown]') || target.closest('[data-bank-toggle]')) return;
      setOpenSel(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [openSel]);

  function getOptionsForType(type: AllocType): SelectOption[] {
    if (type === 'supplier') return suppliers;
    if (type === 'customer') return customers;
    return glAccounts;
  }

  function filterOptions(options: SelectOption[], q: string): SelectOption[] {
    if (!q) return options;
    const lq = q.toLowerCase();
    return options.filter(o =>
      (o.code || '').toLowerCase().includes(lq) ||
      o.name.toLowerCase().includes(lq)
    );
  }

  const TH = 'py-2 px-2 font-medium text-left';

  return (
    <div className="overflow-x-auto" ref={ref}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs">
            <th className="py-2 px-2 w-8">
              <input type="checkbox" checked={allSelected} onChange={onSelectAll} className="accent-emerald-500" />
            </th>
            <th className={`${TH} w-24`}>Date</th>
            <th className={TH}>Description</th>
            <th className={`${TH} w-36`}>Notes</th>
            <th className={`${TH} w-24`}>Type</th>
            <th className={`${TH} w-52`}>Selection</th>
            <th className={`${TH} w-24`}>VAT</th>
            <th className={`${TH} w-24`}>CC1</th>
            <th className={`${TH} w-24`}>CC2</th>
            <th className={`${TH} w-24`}>BU</th>
            <th className="py-2 px-2 font-medium text-right w-24">Spent</th>
            <th className="py-2 px-2 font-medium text-right w-24">Received</th>
            <th className="py-2 px-2 font-medium text-center w-16">Actions</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map(tx => {
            const isNew = tx.status === 'imported';
            const isAllocated = tx.status === 'allocated';
            const sel = rowSelections[tx.id];
            const rowType: AllocType = sel?.type || 'account';
            const isOpen = openSel === tx.id;
            const spent = tx.amount < 0 ? Math.abs(tx.amount) : null;
            const received = tx.amount > 0 ? tx.amount : null;
            const options = filterOptions(getOptionsForType(rowType), isOpen ? search : '');

            const isExcluded = tx.status === 'excluded';

            return (
              <tr key={tx.id} className={`border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-secondary)]/50 ${
                isOpen ? 'bg-blue-500/5' : isAllocated ? 'bg-emerald-500/5' : ''
              } ${isExcluded ? 'opacity-60' : ''}`}>
                <td className="py-2 px-2">
                  <input type="checkbox" checked={selectedIds.has(tx.id)}
                    onChange={() => onToggleSelect(tx.id)} className="accent-emerald-500" />
                </td>
                <td className="py-2 px-2 font-mono text-xs text-[var(--ff-text-secondary)]">
                  {tx.transactionDate}
                </td>
                <td className="py-2 px-2 text-[var(--ff-text-primary)]">
                  <span className="line-clamp-1 text-xs">{tx.description || '—'}</span>
                </td>
                {/* Notes — inline editable */}
                <td className="py-2 px-2">
                  {onUpdateNotes ? (
                    <NotesCell
                      txId={tx.id}
                      initialValue={tx.notes || ''}
                      onSave={onUpdateNotes}
                    />
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)]">{tx.notes || ''}</span>
                  )}
                </td>
                {/* Type dropdown — Account / Supplier / Customer */}
                <td className="py-2 px-2">
                  {isNew ? (
                    <select
                      value={rowType}
                      onChange={e => onRowTypeChange(tx.id, e.target.value as AllocType)}
                      className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] w-full"
                    >
                      <option value="account">Account</option>
                      <option value="supplier">Supplier</option>
                      <option value="customer">Customer</option>
                    </select>
                  ) : (
                    <span className={`text-xs font-medium ${
                      (tx.allocationType || sel?.type) === 'supplier' ? 'text-blue-400'
                      : (tx.allocationType || sel?.type) === 'customer' ? 'text-purple-400'
                      : 'text-[var(--ff-text-secondary)]'
                    }`}>
                      {(tx.allocationType || sel?.type) === 'supplier' ? 'Supplier'
                       : (tx.allocationType || sel?.type) === 'customer' ? 'Customer'
                       : 'Account'}
                    </span>
                  )}
                </td>
                {/* Selection — GL account / Supplier / Customer selector */}
                <td className="py-2 px-2 relative">
                  {isNew ? (
                    <>
                      {/* Amber dot for suggested (not yet confirmed) allocations */}
                      {tx.suggestedGlAccountId && sel?.entityId === tx.suggestedGlAccountId && (
                        <span className="absolute left-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-amber-400" title="Suggested by rule" />
                      )}
                      <button
                        data-bank-toggle
                        onClick={() => { setOpenSel(isOpen ? null : tx.id); setSearch(''); }}
                        className={`text-xs px-2 py-0.5 rounded truncate max-w-[200px] block ${
                          sel?.entityId
                            ? tx.suggestedGlAccountId && sel.entityId === tx.suggestedGlAccountId
                              ? 'text-amber-300 bg-amber-500/10 border border-amber-500/30'
                              : 'text-[var(--ff-text-primary)] bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]'
                            : rowType === 'account'
                              ? 'text-amber-400 bg-amber-500/10 font-medium'
                              : rowType === 'supplier'
                                ? 'text-blue-400 bg-blue-500/10 font-medium'
                                : 'text-purple-400 bg-purple-500/10 font-medium'
                        }`}
                      >
                        {sel?.entityId ? sel.label : (
                          rowType === 'supplier' ? 'Select Supplier'
                          : rowType === 'customer' ? 'Select Customer'
                          : 'Unallocated'
                        )}
                      </button>
                      {isOpen && (
                        <div data-bank-dropdown className="absolute z-50 top-full left-0 mt-1 w-80 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
                          <div className="p-2">
                            <div className="relative">
                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                              <input type="text"
                                placeholder={`Search ${rowType === 'supplier' ? 'suppliers' : rowType === 'customer' ? 'customers' : 'accounts'}...`}
                                value={search} onChange={e => setSearch(e.target.value)}
                                className="w-full pl-7 pr-2 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                                autoFocus />
                            </div>
                          </div>
                          <div className="max-h-48 overflow-y-auto">
                            {options.map(o => (
                              <button key={o.id}
                                onClick={() => {
                                  onRowEntityChange(tx.id, o.id, o.code ? `${o.code} ${o.name}` : o.name);
                                  setOpenSel(null);
                                }}
                                className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2"
                              >
                                {o.code && <span className="font-mono text-[var(--ff-text-tertiary)] w-10 shrink-0">{o.code}</span>}
                                <span className="text-[var(--ff-text-primary)] truncate">{o.name}</span>
                              </button>
                            ))}
                            {options.length === 0 && (
                              <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results found</div>
                            )}
                          </div>
                          {onCreateEntity && (
                            <div className="border-t border-[var(--ff-border-light)] p-1.5">
                              <button
                                onClick={() => { onCreateEntity(tx.id, rowType); setOpenSel(null); }}
                                className="w-full text-left px-3 py-1.5 text-xs text-emerald-400 hover:bg-emerald-500/10 rounded flex items-center gap-1.5"
                              >
                                <Plus className="h-3 w-3" />
                                New {rowType === 'account' ? 'Account' : rowType === 'supplier' ? 'Supplier' : 'Customer'}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className={`text-xs truncate max-w-[200px] block ${
                      (tx.allocationType) === 'supplier' ? 'text-blue-400'
                      : (tx.allocationType) === 'customer' ? 'text-purple-400'
                      : 'text-emerald-400'
                    }`} title={tx.allocatedEntityName || sel?.label || 'Allocated'}>
                      {tx.allocatedEntityName || sel?.label || 'Allocated'}
                    </span>
                  )}
                </td>
                <td className="py-2 px-2">
                  {sel?.type === 'supplier' || sel?.type === 'customer' ? (
                    <span className="text-xs text-[var(--ff-text-tertiary)] italic">N/A</span>
                  ) : isNew ? (
                    <select
                      value={sel?.vatCode || 'none'}
                      onChange={e => onRowVatChange(tx.id, e.target.value as VatCode)}
                      className={`text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full ${
                        (sel?.vatCode || 'none') === 'standard'
                          ? 'text-cyan-400' : 'text-[var(--ff-text-primary)]'
                      }`}
                    >
                      {VAT_OPTIONS.map(v => (
                        <option key={v.value} value={v.value}>{v.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)]">
                      {VAT_OPTIONS.find(v => v.value === (sel?.vatCode || 'none'))?.label || 'No VAT'}
                    </span>
                  )}
                </td>
                {/* CC1 */}
                <td className="py-2 px-2">
                  {isNew ? (
                    <select value={sel?.cc1Id || ''} onChange={e => onRowDimensionChange(tx.id, e.target.value, sel?.cc2Id || '', sel?.buId || '')}
                      className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full text-[var(--ff-text-primary)]">
                      <option value="">—</option>
                      {cc1Options.map(o => <option key={o.id} value={o.id}>{o.code ? `${o.code} ${o.name}` : o.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)] truncate block" title={tx.cc1Name}>{tx.cc1Name || '—'}</span>
                  )}
                </td>
                {/* CC2 */}
                <td className="py-2 px-2">
                  {isNew ? (
                    <select value={sel?.cc2Id || ''} onChange={e => onRowDimensionChange(tx.id, sel?.cc1Id || '', e.target.value, sel?.buId || '')}
                      className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full text-[var(--ff-text-primary)]">
                      <option value="">—</option>
                      {cc2Options.map(o => <option key={o.id} value={o.id}>{o.code ? `${o.code} ${o.name}` : o.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)] truncate block" title={tx.cc2Name}>{tx.cc2Name || '—'}</span>
                  )}
                </td>
                {/* BU */}
                <td className="py-2 px-2">
                  {isNew ? (
                    <select value={sel?.buId || ''} onChange={e => onRowDimensionChange(tx.id, sel?.cc1Id || '', sel?.cc2Id || '', e.target.value)}
                      className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] w-full text-[var(--ff-text-primary)]">
                      <option value="">—</option>
                      {buOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)] truncate block" title={tx.buName}>{tx.buName || '—'}</span>
                  )}
                </td>
                <td className="py-2 px-2 text-right font-mono text-xs text-red-400">
                  {spent !== null ? fmtCurrency(spent) : ''}
                </td>
                <td className="py-2 px-2 text-right font-mono text-xs text-emerald-400">
                  {received !== null ? fmtCurrency(received) : ''}
                </td>
                <td className="py-2 px-2 text-center">
                  {isExcluded ? (
                    /* Excluded tab: show reason badge spanning the actions column */
                    <div className="flex items-center gap-1 justify-center">
                      {tx.excludeReason ? (
                        <span
                          title={tx.excludeReason}
                          className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 max-w-[120px] truncate inline-block"
                        >
                          {tx.excludeReason}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--ff-text-tertiary)] italic">Excluded</span>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-0.5 justify-center">
                      {isNew ? (
                        <>
                          <button onClick={() => onAccept(tx.id)} disabled={!sel?.entityId} title="Accept"
                            className="p-1 rounded hover:bg-emerald-500/10 text-emerald-400 disabled:opacity-30">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          {onFindMatch && (
                            <button onClick={() => onFindMatch(tx.id)} title="Find & Match"
                              className="p-1 rounded hover:bg-blue-500/10 text-blue-400">
                              <SearchCheck className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button onClick={() => onSplit(tx.id)} title="Split transaction"
                            className="p-1 rounded hover:bg-purple-500/10 text-purple-400">
                            <Scissors className="h-3.5 w-3.5" />
                          </button>
                          {onCreateRule && !tx.suggestedGlAccountId && (
                            <button onClick={() => onCreateRule(tx)} title="Create rule from this transaction"
                              className="p-1 rounded hover:bg-yellow-500/10 text-yellow-400">
                              <BookmarkPlus className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {onAttachments && (
                            <button onClick={() => onAttachments(tx.id)} title="Attachments"
                              className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                              <Paperclip className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button onClick={() => onExclude(tx.id)} title="Exclude"
                            className="p-1 rounded hover:bg-red-500/10 text-red-400">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </>
                      ) : isAllocated ? (
                        <>
                          {onReverse && (
                            <button onClick={() => onReverse(tx.id)} title="Undo allocation"
                              className="p-1 rounded hover:bg-amber-500/10 text-amber-400">
                              <Undo2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {onAttachments && (
                            <button onClick={() => onAttachments(tx.id)} title="Attachments"
                              className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                              <Paperclip className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button onClick={() => onUnmatch(tx.id)} title="Undo allocation"
                            className="p-1 rounded hover:bg-amber-500/10 text-amber-400">
                            <Undo2 className="h-3.5 w-3.5" />
                          </button>
                          {onReverse && tx.status === 'reconciled' && (
                            <button onClick={() => onReverse(tx.id)} title="Reverse reconciled"
                              className="p-1 rounded hover:bg-red-500/10 text-red-400">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {onAttachments && (
                            <button onClick={() => onAttachments(tx.id)} title="Attachments"
                              className="p-1 rounded hover:bg-gray-500/10 text-[var(--ff-text-tertiary)]">
                              <Paperclip className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
