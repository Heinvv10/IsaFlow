/**
 * Sage-style bank transaction table with inline allocation
 * Type selector: Account / Supplier / Customer — Selection dropdown changes accordingly
 * VAT selector: No VAT / Standard 15% / Zero-Rated / Exempt
 * Notes: inline-editable per row, saved on blur
 */

import { useState, useRef, useEffect } from 'react';
import { useBankTxKeyboardNav } from '@/components/accounting/useBankTxKeyboardNav';
import { isPendingFeedRow } from './bank-transactions/pendingFeedRow';
import type { BankTxTableProps } from './bankTx/bankTxTypes';
import { BankTxRow } from './bankTx/BankTxRow';

export { VAT_OPTIONS } from './bankTx/bankTxTypes';
export type { AllocType, VatCode, BankTx, SelectOption, RowSelection } from './bankTx/bankTxTypes';

export function BankTxTable(props: BankTxTableProps) {
  const {
    transactions, showCC, showBU,
    rowSelections, allSelected, tab,
    onSelectAll,
    onAccept, onExclude, onSplit,
  } = props;
  const { containerProps, getRowProps } = useBankTxKeyboardNav({
    transactions, rowSelections, onAccept, onExclude, onSplit,
  });
  const kbdEnabled = tab === 'new';
  // Select-all is meaningless when every visible row is pending at the bank —
  // there is nothing actionable to select.
  const allRowsPending = transactions.length > 0 && transactions.every(isPendingFeedRow);
  const [openSel, setOpenSel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dropUp, setDropUp] = useState(false);
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

  const TH = 'py-2 px-2 font-medium text-left';

  return (
    <div className="overflow-x-auto" ref={ref}>
      <div
        {...(kbdEnabled ? containerProps : {})}
        tabIndex={kbdEnabled ? 0 : undefined}
        role={kbdEnabled ? 'group' : undefined}
        aria-label={kbdEnabled ? 'Bank transactions — use arrow keys to navigate, Enter to accept, E edit, X exclude, S split' : undefined}
        className="outline-none"
      >
        <table data-testid="bank-tx-table" className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs">
              <th className="py-2 px-2 w-8">
                <input type="checkbox" checked={allSelected} disabled={allRowsPending} onChange={onSelectAll} className="accent-teal-500"
                  aria-label="Select all transactions on this page" />
              </th>
              <th className={`${TH} w-24`}>Date</th>
              <th className={TH}>Description</th>
              <th className={`${TH} w-36`}>Notes</th>
              <th className={`${TH} w-24`}>Type</th>
              <th className={`${TH} w-52`}>Selection</th>
              {/* Always rendered. Deriving its presence from the loaded rows made the
                  column appear and vanish between pages depending on which rows
                  happened to be rule-allocated. */}
              <th className={`${TH} w-32`}>Rule</th>
              <th className={`${TH} w-24`}>VAT</th>
              {showCC && <th className={`${TH} w-24`}>CC1</th>}
              {showCC && <th className={`${TH} w-24`}>CC2</th>}
              {showBU && <th className={`${TH} w-24`}>BU</th>}
              <th className="py-2 px-2 font-medium text-right w-24">Spent</th>
              <th className="py-2 px-2 font-medium text-right w-24">Received</th>
              <th className="py-2 px-2 font-medium text-center w-16">Actions</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx, index) => (
              <BankTxRow
                key={tx.id}
                tx={tx}
                rowProps={kbdEnabled ? getRowProps(index) : {}}
                table={props}
                dropdown={{ openSel, search, dropUp, setOpenSel, setSearch, setDropUp }}
              />
            ))}
          </tbody>
        </table>
        {tab === 'new' && transactions.length > 0 && (
          <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)] border-t border-[var(--ff-border-light)]/50 flex gap-4">
            <span><kbd className="font-mono">↑↓</kbd> move</span>
            <span><kbd className="font-mono">Enter</kbd> accept</span>
            <span><kbd className="font-mono">E</kbd> edit</span>
            <span><kbd className="font-mono">X</kbd> exclude</span>
            <span><kbd className="font-mono">S</kbd> split</span>
          </div>
        )}
      </div>
    </div>
  );
}
