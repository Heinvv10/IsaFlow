/**
 * One bank transaction row: select, date, description, notes, type, then the Selection, Rule,
 * dimension, amount and action cells.
 */

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Clock } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { RowProps } from '../useBankTxKeyboardNav';
import { isPendingFeedRow, PendingFeedBadge } from '../bank-transactions/pendingFeedRow';
import type { AllocType, BankTx, BankTxTableProps } from './bankTxTypes';
import { rowLabel } from './bankTxRowLabel';
import { BankTxSelectionCell, type BankTxDropdownState } from './BankTxSelectionCell';
import { BankTxDimensionCells } from './BankTxDimensionCells';
import { BankTxRowActions } from './BankTxRowActions';

function fmtCurrency(n: number): string {
  return formatMoney(n);
}

/**
 * Inline-editable notes cell.
 * Renders as gray placeholder text when empty, saves on blur.
 */
function NotesCell({
  txId, label, initialValue, onSave,
}: {
  txId: string;
  /** rowLabel(tx), for the accessible name. */
  label: string;
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
        aria-label={`Note, ${label}`}
        autoFocus
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="text-xs truncate max-w-[140px] block text-left hover:text-[var(--ff-text-primary)] transition-colors"
      title={value || 'Click to add note'}
      aria-label={value ? `Note, ${label}: ${value}` : `Add note, ${label}`}
    >
      {value
        ? <span className="text-[var(--ff-text-secondary)]">{value}</span>
        : <span className="text-[var(--ff-text-tertiary)] italic">Add note...</span>
      }
    </button>
  );
}

interface Props {
  tx: BankTx;
  /** Keyboard-nav props for the row; empty when keyboard nav is off for this tab. */
  rowProps: RowProps | Record<string, never>;
  table: BankTxTableProps;
  dropdown: BankTxDropdownState;
}

export function BankTxRow({ tx, rowProps, table, dropdown }: Props) {
  const { selectedIds, rowSelections, onToggleSelect, onRowTypeChange, onUpdateNotes } = table;
  const isNew = tx.status === 'imported';
  const isAllocated = tx.status === 'allocated';
  const sel = rowSelections[tx.id];
  const rowType: AllocType = sel?.type || 'account';
  const isOpen = dropdown.openSel === tx.id;
  const spent = tx.amount < 0 ? Math.abs(tx.amount) : null;
  const received = tx.amount > 0 ? tx.amount : null;

  const isExcluded = tx.status === 'excluded';
  const label = rowLabel(tx);

  return (
    <tr
      {...rowProps}
      className={`border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-secondary)]/50 outline-none data-[focused]:bg-[var(--ff-bg-tertiary)] data-[focused]:ring-1 data-[focused]:ring-inset data-[focused]:ring-[var(--ff-border-secondary)] ${
        isOpen ? 'bg-blue-500/5' : isAllocated ? 'bg-teal-500/5' : ''
      } ${isExcluded ? 'opacity-60' : ''}`}
    >
      <td className="py-2 px-2">
        <input type="checkbox" checked={selectedIds.has(tx.id)}
          disabled={isPendingFeedRow(tx)}
          onChange={() => onToggleSelect(tx.id)} className="accent-teal-500"
          aria-label={`Select ${label}`} />
      </td>
      <td className="py-2 px-2 font-mono text-xs text-[var(--ff-text-secondary)]">
        {formatDisplayDate(tx.transactionDate)}
      </td>
      <td className="py-2 px-2 text-[var(--ff-text-primary)]">
        <span className="line-clamp-1 text-xs">{tx.description || '—'}</span>
        {isPendingFeedRow(tx) && <PendingFeedBadge />}
        {tx.status === 'provisional' && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-amber-900/40 text-amber-300 ml-1"
            title="Posted by AI — needs evidence">
            <Clock className="h-2.5 w-2.5" /> Provisional
          </span>
        )}
        {tx.needsEvidence && tx.provisionalJeId && (
          <Link href={`/accounting/bank/provisional#${tx.id}`}
            className="ml-1 text-xs text-teal-400 hover:underline">
            Attach slip
          </Link>
        )}
      </td>
      {/* Notes — inline editable */}
      <td className="py-2 px-2">
        {onUpdateNotes ? (
          <NotesCell
            txId={tx.id}
            label={label}
            initialValue={tx.notes || ''}
            onSave={onUpdateNotes}
          />
        ) : (
          <span className="text-xs text-[var(--ff-text-tertiary)]">{tx.notes || ''}</span>
        )}
      </td>
      {/* Type dropdown — Account / Supplier / Customer / Transfer */}
      <td className="py-2 px-2">
        {isNew ? (
          <select
            value={rowType}
            onChange={e => onRowTypeChange(tx.id, e.target.value as AllocType)}
            aria-label={`Allocation type, ${label}`}
            className="text-xs px-1 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] w-full"
          >
            <option value="account">Account</option>
            <option value="supplier">Supplier</option>
            <option value="customer">Customer</option>
            <option value="transfer">Transfer</option>
          </select>
        ) : (
          <span className={`text-xs font-medium ${
            (tx.allocationType || sel?.type) === 'supplier' ? 'text-blue-400'
            : (tx.allocationType || sel?.type) === 'customer' ? 'text-purple-400'
            : (tx.allocationType || sel?.type) === 'transfer' ? 'text-orange-400'
            : 'text-[var(--ff-text-secondary)]'
          }`}>
            {(tx.allocationType || sel?.type) === 'supplier' ? 'Supplier'
             : (tx.allocationType || sel?.type) === 'customer' ? 'Customer'
             : (tx.allocationType || sel?.type) === 'transfer' ? 'Transfer'
             : 'Account'}
          </span>
        )}
      </td>
      {/* Selection — GL account / Supplier / Customer selector */}
      <BankTxSelectionCell tx={tx} sel={sel} rowType={rowType} isNew={isNew} label={label} table={table} dropdown={dropdown} />
      <td className="py-2 px-2">
        <span className="text-xs text-[var(--ff-text-tertiary)] truncate max-w-[120px] block"
          title={tx.allocationRuleName || ''}>
          {tx.allocationRuleName || '—'}
        </span>
      </td>
      <BankTxDimensionCells tx={tx} sel={sel} rowType={rowType} isNew={isNew} label={label} table={table} />
      <td className="py-2 px-2 text-right tabular-nums text-xs text-red-400">
        {spent !== null ? fmtCurrency(spent) : ''}
      </td>
      <td className="py-2 px-2 text-right tabular-nums text-xs text-teal-400">
        {received !== null ? fmtCurrency(received) : ''}
      </td>
      <BankTxRowActions tx={tx} sel={sel} isNew={isNew} isAllocated={isAllocated} isExcluded={isExcluded} table={table} />
    </tr>
  );
}
