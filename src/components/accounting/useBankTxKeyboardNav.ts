/**
 * Keyboard row-stream navigation for BankTxTable. Owns the focused row index,
 * derives the key context, and dispatches to the table's existing callbacks
 * (onAccept/onExclude/onSplit). Hotkeys are suppressed while a cell input is
 * focused (see resolveBankTxKey). 'edit' opens the row's entity dropdown via the
 * [data-bank-toggle] button; 'blur-to-row' returns focus from a cell to the row.
 *
 * No explicit advance after accept: a successful accept reloads the queue and the
 * accepted row drops out, so a fixed index naturally points at the next row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveBankTxKey } from '@/components/accounting/bankTxKeyboard';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

interface UseBankTxKeyboardNavArgs {
  transactions: BankTx[];
  rowSelections: Record<string, RowSelection>;
  onAccept: (txId: string) => void;
  onExclude: (txId: string) => void;
  onSplit: (txId: string) => void;
}

export interface RowProps {
  ref: (el: HTMLTableRowElement | null) => void;
  tabIndex: number;
  'data-focused': true | undefined;
  onClick: () => void;
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

export function useBankTxKeyboardNav({
  transactions, rowSelections, onAccept, onExclude, onSplit,
}: UseBankTxKeyboardNavArgs) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  // Keep the index in range as the queue shrinks (e.g. after accept/exclude reload).
  useEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, transactions.length);
    setFocusedIndex(prev => {
      if (prev === null) return prev;
      if (transactions.length === 0) return null;
      return Math.min(prev, transactions.length - 1);
    });
  }, [transactions.length]);

  const focusRow = useCallback((index: number) => {
    rowRefs.current[index]?.focus();
    rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  const registerRow = useCallback((index: number, el: HTMLTableRowElement | null) => {
    rowRefs.current[index] = el;
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (transactions.length === 0) return;
    if (focusedIndex === null) {
      const entryAction = resolveBankTxKey(e.key, { isEditingCell: isTypingTarget(document.activeElement), canAccept: false });
      if (entryAction === 'next' || entryAction === 'prev') {
        e.preventDefault();
        setFocusedIndex(0);
        focusRow(0);
      }
      return;
    }
    const index = focusedIndex;
    const tx = transactions[index];
    if (!tx) return;

    const ctx = {
      isEditingCell: isTypingTarget(document.activeElement),
      canAccept: !!rowSelections[tx.id]?.entityId,
    };
    const action = resolveBankTxKey(e.key, ctx);
    if (!action) return;
    e.preventDefault();

    switch (action) {
      case 'next': {
        const ni = Math.min(index + 1, transactions.length - 1);
        setFocusedIndex(ni); focusRow(ni); break;
      }
      case 'prev': {
        const pi = Math.max(index - 1, 0);
        setFocusedIndex(pi); focusRow(pi); break;
      }
      case 'accept':  onAccept(tx.id); break;
      case 'exclude': onExclude(tx.id); break;
      case 'split':   onSplit(tx.id); break;
      case 'edit': {
        const row = rowRefs.current[index];
        const toggle = row?.querySelector<HTMLElement>('[data-bank-toggle]');
        toggle?.click();
        break;
      }
      case 'blur-to-row': {
        (document.activeElement as HTMLElement | null)?.blur();
        focusRow(index);
        break;
      }
    }
  }, [transactions, rowSelections, focusedIndex, focusRow, onAccept, onExclude, onSplit]);

  const containerProps = useMemo(() => ({ onKeyDown }), [onKeyDown]);

  const getRowProps = (index: number): RowProps => ({
    ref: (el: HTMLTableRowElement | null) => registerRow(index, el),
    tabIndex: -1,
    'data-focused': focusedIndex === index ? true : undefined,
    onClick: () => setFocusedIndex(index),
  });

  return { focusedIndex, containerProps, getRowProps };
}
