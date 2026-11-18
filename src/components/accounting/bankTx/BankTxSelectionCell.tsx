/**
 * The Selection cell of a bank transaction row: the GL account / supplier / customer / bank account
 * trigger, and its popover with search, the pinned suggestion and "New …".
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Search, SearchCheck, Plus } from 'lucide-react';
import { AllocatedAccountCell } from '../BankTxAllocatedAccountCell';
import { SharedPoolHint } from '../bank-transactions/SharedPoolHint';
import type { AllocType, BankTx, BankTxTableProps, RowSelection } from './bankTxTypes';
import { useBankTxSelectionPlacement } from './useBankTxSelectionPlacement';
import { filterOptions, getOptionsForType, getSuggestedOption, nextPopoverIndex, popoverChoices, sortByDescriptionMatch } from './bankTxOptions';
import { TOUCH_PAD } from './bankTxTouch';

/** The table's single open-popover state, handed to every row. */
export interface BankTxDropdownState {
  openSel: string | null;
  search: string;
  setOpenSel: Dispatch<SetStateAction<string | null>>;
  setSearch: Dispatch<SetStateAction<string>>;
}

interface Props {
  tx: BankTx;
  sel: RowSelection | undefined;
  rowType: AllocType;
  isNew: boolean;
  /** rowLabel(tx), for the accessible names. */
  label: string;
  table: BankTxTableProps;
  dropdown: BankTxDropdownState;
}

export function BankTxSelectionCell({ tx, sel, rowType, isNew, label, table, dropdown }: Props) {
  const { suppliersLoading, onRowEntityChange, onCreateEntity } = table;
  const { openSel, search, setOpenSel, setSearch } = dropdown;
  const isOpen = openSel === tx.id;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rawOptions = filterOptions(getOptionsForType(rowType, table), isOpen ? search : '');
  const options = (isOpen && !search) ? sortByDescriptionMatch(rawOptions, tx.description || '') : rawOptions;
  const choices = popoverChoices(tx, rowType, isOpen ? search : '', options);
  // The entry Enter picks: the first, until the arrows move it. Typing starts again from the first match.
  const [active, setActive] = useState(0);
  useEffect(() => { setActive(0); }, [search, isOpen]);
  // The entry the arrows reached must stay visible in the list (max-h-48 scrolls).
  useEffect(() => {
    if (isOpen) document.getElementById(`bank-choice-${tx.id}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, isOpen, tx.id]);
  const pick = (o: { id: string; name: string; code?: string | null }) => {
    onRowEntityChange(tx.id, o.id, o.code ? `${o.code} ${o.name}` : o.name);
    closePopover();
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const to = nextPopoverIndex(e.key, active, choices.length);
    if (to !== null) { e.preventDefault(); setActive(to); return; }
    // Enter that confirms an IME composition (CJK, accents) is the composition's, not a pick.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && choices.length > 0) { e.preventDefault(); e.stopPropagation(); pick(choices[Math.min(active, choices.length - 1)]!); }
  };
  const place = useBankTxSelectionPlacement(toggleRef, isOpen, options.length + 1, !!onCreateEntity && rowType !== 'transfer');
  /** The grid's row: where keys go once the popover is closed (a removed option would drop focus to the body). */
  const focusRow = () => {
    const row = toggleRef.current?.closest('tr');
    // Keyboard nav off: the row is not focusable, so the toggle keeps focus.
    (row?.hasAttribute('tabindex') ? row : toggleRef.current)?.focus();
  };
  const closePopover = () => { setOpenSel(null); focusRow(); };
  const triggerText = sel?.entityId ? sel.label : (
    rowType === 'supplier' ? 'Select Supplier'
    : rowType === 'customer' ? 'Select Customer'
    : rowType === 'transfer' ? 'Select Bank Account'
    : 'Unallocated'
  );
  const entityNoun = rowType === 'transfer' ? 'bank account' : rowType;
  const searchNoun = rowType === 'supplier' ? 'suppliers' : rowType === 'customer' ? 'customers' : rowType === 'transfer' ? 'bank accounts' : 'accounts';

  return (
    <td data-label="Selection" className="py-1 px-2 relative">
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
            ref={toggleRef}
            onKeyDown={(e) => { if (e.key === 'Escape' && isOpen) { e.stopPropagation(); closePopover(); } }}
            onClick={() => {
              if (isOpen) { setOpenSel(null); return; }
              setOpenSel(tx.id); setSearch('');
            }}
            aria-label={`${triggerText}. Choose ${entityNoun}, ${label}`}
            aria-expanded={isOpen}
            className={`text-xs px-2 py-0.5 rounded truncate max-w-[200px] block ${TOUCH_PAD} ${
              sel?.entityId
                ? tx.suggestedGlAccountId && sel.entityId === tx.suggestedGlAccountId
                  ? 'text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30'
                  : 'text-[var(--ff-text-primary)] bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]'
                : rowType === 'account'
                  ? 'text-amber-700 dark:text-amber-400 bg-amber-500/10 font-medium'
                  : rowType === 'supplier'
                    ? 'text-blue-700 dark:text-blue-400 bg-blue-500/10 font-medium'
                    : rowType === 'transfer'
                      ? 'text-orange-700 dark:text-orange-400 bg-orange-500/10 font-medium'
                      : 'text-purple-700 dark:text-purple-400 bg-purple-500/10 font-medium'
            }`}
          >
            {triggerText}
          </button>
          <SharedPoolHint suggestedStrategy={tx.suggestedStrategy} suggestedGlAccountId={tx.suggestedGlAccountId} selectedEntityId={sel?.entityId} />
          {isOpen && place && (
            <div data-bank-dropdown
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } }}
              style={{ top: place.top, bottom: place.bottom, left: place.left, maxHeight: place.maxHeight }}
              className="fixed z-50 flex w-80 flex-col overflow-hidden bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
              <div className="p-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                  <input type="text"
                    placeholder={`Search ${searchNoun}...`}
                    aria-label={`Search ${searchNoun}`}
                    value={search} onChange={e => setSearch(e.target.value)}
                    onKeyDown={onSearchKey}
                    aria-activedescendant={choices.length > 0 ? `bank-choice-${tx.id}-${Math.min(active, choices.length - 1)}` : undefined}
                    className="w-full pl-7 pr-2 py-1.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                    autoFocus />
                </div>
              </div>
              <div className="min-h-0 max-h-48 overflow-y-auto">
                {/* Suggested option pinned at top */}
                {(() => {
                  const suggested = getSuggestedOption(tx, rowType);
                  if (!suggested || search) return null;
                  return (
                    <>
                      <div className="px-3 py-1 text-xs font-semibold text-teal-700 dark:text-teal-400 uppercase tracking-wider bg-teal-500/5">
                        <SearchCheck className="inline h-3 w-3 mr-1 -mt-0.5" />
                        Suggested{tx.suggestedCategory ? ` — ${tx.suggestedCategory}` : ''}
                      </div>
                      <button
                        id={`bank-choice-${tx.id}-0`} data-active={active === 0 || undefined}
                        onClick={() => pick(suggested)}
                        className="w-full text-left px-3 py-1.5 hover:bg-teal-500/10 data-[active]:ring-1 data-[active]:ring-teal-400 text-xs flex items-center gap-2 bg-teal-500/5 border-b border-teal-500/20"
                      >
                        {suggested.code && <span className="font-id text-teal-700 dark:text-teal-400 w-10 shrink-0">{suggested.code}</span>}
                        <span className="text-teal-700 dark:text-teal-300 truncate font-medium">{suggested.name}</span>
                      </button>
                    </>
                  );
                })()}
                {options.map((o, i) => {
                  const at = choices.length - options.length + i;
                  return (
                  <button key={o.id}
                    id={`bank-choice-${tx.id}-${at}`} data-active={active === at || undefined}
                    onClick={() => pick(o)}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] data-[active]:bg-[var(--ff-bg-primary)] data-[active]:ring-1 data-[active]:ring-teal-400 text-xs flex items-center gap-2"
                  >
                    {o.code && <span className="font-id text-[var(--ff-text-tertiary)] w-10 shrink-0">{o.code}</span>}
                    <span className="text-[var(--ff-text-primary)] truncate">{o.name}</span>
                  </button>
                  );
                })}
                {options.length === 0 && !getSuggestedOption(tx, rowType) && (
                  <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">{rowType === 'supplier' && suppliersLoading ? 'Loading suppliers…' : 'No results found'}</div>
                )}
              </div>
              {onCreateEntity && rowType !== 'transfer' && (
                <div className="border-t border-[var(--ff-border-light)] p-1.5">
                  <button
                    onClick={() => { onCreateEntity(tx.id, rowType); closePopover(); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-teal-700 dark:text-teal-400 hover:bg-teal-500/10 rounded flex items-center gap-1.5"
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
