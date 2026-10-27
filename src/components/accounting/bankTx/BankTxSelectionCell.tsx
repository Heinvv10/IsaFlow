/**
 * The Selection cell of a bank transaction row: the GL account / supplier / customer / bank account
 * trigger, and its popover with search, the pinned suggestion and "New …".
 */

import type { Dispatch, SetStateAction } from 'react';
import { Search, SearchCheck, Plus } from 'lucide-react';
import { AllocatedAccountCell } from '../BankTxAllocatedAccountCell';
import { SharedPoolHint } from '../bank-transactions/SharedPoolHint';
import type { AllocType, BankTx, BankTxTableProps, RowSelection } from './bankTxTypes';
import { filterOptions, getOptionsForType, getSuggestedOption, sortByDescriptionMatch } from './bankTxOptions';

/** The table's single open-popover state, handed to every row. */
export interface BankTxDropdownState {
  openSel: string | null;
  search: string;
  dropUp: boolean;
  setOpenSel: Dispatch<SetStateAction<string | null>>;
  setSearch: Dispatch<SetStateAction<string>>;
  setDropUp: Dispatch<SetStateAction<boolean>>;
}

interface Props {
  tx: BankTx;
  sel: RowSelection | undefined;
  rowType: AllocType;
  isNew: boolean;
  table: BankTxTableProps;
  dropdown: BankTxDropdownState;
}

export function BankTxSelectionCell({ tx, sel, rowType, isNew, table, dropdown }: Props) {
  const { suppliersLoading, onRowEntityChange, onCreateEntity } = table;
  const { openSel, search, dropUp, setOpenSel, setSearch, setDropUp } = dropdown;
  const isOpen = openSel === tx.id;
  const rawOptions = filterOptions(getOptionsForType(rowType, table), isOpen ? search : '');
  const options = (isOpen && !search) ? sortByDescriptionMatch(rawOptions, tx.description || '') : rawOptions;

  return (
    <td className="py-2 px-2 relative">
      {isNew ? (
        <>
          {/* Confidence dot for suggested allocations — green=HIGH, yellow=MEDIUM, grey=LOW */}
          {(tx.suggestedGlAccountId || tx.suggestedSupplierId || tx.suggestedClientId) && sel?.entityId && (
            <span
              className={`absolute left-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full ${
                (tx.suggestedConfidence ?? 0) >= 0.85
                  ? 'bg-emerald-400'
                  : (tx.suggestedConfidence ?? 0) >= 0.60
                    ? 'bg-amber-400'
                    : 'bg-gray-400'
              }`}
              title={`Confidence: ${tx.suggestedConfidence != null ? `${Math.round(tx.suggestedConfidence * 100)}%` : 'Rule match'}${tx.suggestedCategory ? ` — ${tx.suggestedCategory}` : ''}`}
            />
          )}
          <button
            data-bank-toggle
            onClick={(e) => {
              if (isOpen) { setOpenSel(null); return; }
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDropUp(rect.bottom + 260 > window.innerHeight);
              setOpenSel(tx.id); setSearch('');
            }}
            className={`text-xs px-2 py-0.5 rounded truncate max-w-[200px] block ${
              sel?.entityId
                ? tx.suggestedGlAccountId && sel.entityId === tx.suggestedGlAccountId
                  ? 'text-amber-300 bg-amber-500/10 border border-amber-500/30'
                  : 'text-[var(--ff-text-primary)] bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]'
                : rowType === 'account'
                  ? 'text-amber-400 bg-amber-500/10 font-medium'
                  : rowType === 'supplier'
                    ? 'text-blue-400 bg-blue-500/10 font-medium'
                    : rowType === 'transfer'
                      ? 'text-orange-400 bg-orange-500/10 font-medium'
                      : 'text-purple-400 bg-purple-500/10 font-medium'
            }`}
          >
            {sel?.entityId ? sel.label : (
              rowType === 'supplier' ? 'Select Supplier'
              : rowType === 'customer' ? 'Select Customer'
              : rowType === 'transfer' ? 'Select Bank Account'
              : 'Unallocated'
            )}
          </button>
          <SharedPoolHint suggestedStrategy={tx.suggestedStrategy} suggestedGlAccountId={tx.suggestedGlAccountId} selectedEntityId={sel?.entityId} />
          {isOpen && (
            <div data-bank-dropdown className={`absolute z-50 left-0 w-80 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
              <div className="p-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                  <input type="text"
                    placeholder={`Search ${rowType === 'supplier' ? 'suppliers' : rowType === 'customer' ? 'customers' : rowType === 'transfer' ? 'bank accounts' : 'accounts'}...`}
                    value={search} onChange={e => setSearch(e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                    autoFocus />
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {/* Suggested option pinned at top */}
                {(() => {
                  const suggested = getSuggestedOption(tx, rowType);
                  if (!suggested || search) return null;
                  return (
                    <>
                      <div className="px-3 py-1 text-xs font-semibold text-teal-400 uppercase tracking-wider bg-teal-500/5">
                        <SearchCheck className="inline h-3 w-3 mr-1 -mt-0.5" />
                        Suggested{tx.suggestedCategory ? ` — ${tx.suggestedCategory}` : ''}
                      </div>
                      <button
                        onClick={() => {
                          onRowEntityChange(tx.id, suggested.id, suggested.code ? `${suggested.code} ${suggested.name}` : suggested.name);
                          setOpenSel(null);
                        }}
                        className="w-full text-left px-3 py-1.5 hover:bg-teal-500/10 text-xs flex items-center gap-2 bg-teal-500/5 border-b border-teal-500/20"
                      >
                        {suggested.code && <span className="font-mono text-teal-400 w-10 shrink-0">{suggested.code}</span>}
                        <span className="text-teal-300 truncate font-medium">{suggested.name}</span>
                      </button>
                    </>
                  );
                })()}
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
                {options.length === 0 && !getSuggestedOption(tx, rowType) && (
                  <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">{rowType === 'supplier' && suppliersLoading ? 'Loading suppliers…' : 'No results found'}</div>
                )}
              </div>
              {onCreateEntity && rowType !== 'transfer' && (
                <div className="border-t border-[var(--ff-border-light)] p-1.5">
                  <button
                    onClick={() => { onCreateEntity(tx.id, rowType); setOpenSel(null); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-teal-400 hover:bg-teal-500/10 rounded flex items-center gap-1.5"
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
        <AllocatedAccountCell tx={tx} fallbackLabel={sel?.label} />
      )}
    </td>
  );
}
