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
  const prevLenRef = useRef(transactions.length);
  const focusedIndexRef = useRef<number | null>(null);

  useEffect(() => { focusedIndexRef.current = focusedIndex; }, [focusedIndex]);

  const focusRow = useCallback((index: number) => {
    rowRefs.current[index]?.focus();
    rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Keep the focused index in range as the queue changes, and — when it SHRANK
  // while navigating (e.g. after an accept reloaded the list) — restore DOM focus
  // to the row now at the clamped index. Without this the unmounted <tr> drops
  // focus to <body>, outside the keydown container, stalling the stream.
  useEffect(() => {
    const prevLen = prevLenRef.current;
    prevLenRef.current = transactions.length;
    rowRefs.current = rowRefs.current.slice(0, transactions.length);

    const cur = focusedIndexRef.current;
    if (cur === null) return;
    if (transactions.length === 0) { setFocusedIndex(null); return; }

    const next = Math.min(cur, transactions.length - 1);
    if (next !== cur) setFocusedIndex(next);
    if (transactions.length < prevLen) focusRow(next);
  }, [transactions.length, focusRow]);

  const registerRow = useCallback((index: number, el: HTMLTableRowElement | null) => {
    rowRefs.current[index] = el;
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (transactions.length === 0) return;
    if (focusedIndex === null) {
      // Nothing focused yet: only an arrow key enters the stream (focus row 0).
      // canAccept is passed false here purely because no row is selected — it is
      // irrelevant since we only act on 'next'/'prev' below, never 'accept'.
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
