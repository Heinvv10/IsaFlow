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
import { log } from '@/lib/logger';
import { resolveBankTxKey } from '@/components/accounting/bankTxKeyboard';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

interface UseBankTxKeyboardNavArgs {
  transactions: BankTx[];
  rowSelections: Record<string, RowSelection>;
  /** A returned promise resolves true when the row was actually posted / excluded / split, false on error or cancel. */
  onAccept: (txId: string) => void | Promise<boolean>;
  onExclude: (txId: string) => void | Promise<boolean>;
  onSplit: (txId: string) => void | Promise<boolean>;
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
  // A kit Select's trigger is a div with role="combobox": its Enter, Space and letters choose and type ahead.
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.getAttribute('role') === 'combobox'
    || (el as HTMLElement).isContentEditable;
}

/**
 * The key belongs to an open dropdown, never to the row stream: it was pressed in a portalled panel (React bubbles
 * a portal's events through its owner, so they arrive here from outside the grid's DOM), or on a combobox that is
 * still expanded (its Escape closes the list; only a second Escape leaves the cell).
 */
function isDropdownKey(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (!e.currentTarget.contains(e.target as Node)) return true;
  const el = document.activeElement;
  return el?.getAttribute('role') === 'combobox' && el.getAttribute('aria-expanded') === 'true';
}

export function useBankTxKeyboardNav({
  transactions, rowSelections, onAccept, onExclude, onSplit,
}: UseBankTxKeyboardNavArgs) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const focusedIndexRef = useRef<number | null>(null);
  /** The focused row by id: a sort, a filter or a refresh moves rows, and the index must follow the row. */
  const focusedIdRef = useRef<string | null>(null);
  /** The row our own accept / exclude / split actually completed on: its leaving the list is the stream moving on. */
  const actedIdRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Focus last sat inside the grid. A removed focused row drops focus to the body without a blur, so this is kept. */
  const focusInGridRef = useRef(false);

  useEffect(() => { focusedIndexRef.current = focusedIndex; }, [focusedIndex]);

  const setFocus = useCallback((index: number, id: string | undefined) => {
    focusedIdRef.current = id ?? null;
    actedIdRef.current = null;
    setFocusedIndex(index);
  }, []);

  const focusRow = useCallback((index: number) => {
    rowRefs.current[index]?.focus();
    rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  // Keep the focused index in range as the queue changes, and — when it SHRANK
  // while navigating (e.g. after an accept reloaded the list) — restore DOM focus
  // to the row now at the clamped index. Without this the unmounted <tr> drops
  // focus to <body>, outside the keydown container, stalling the stream.
  useEffect(() => {
    rowRefs.current = rowRefs.current.slice(0, transactions.length);

    // A completed action's mark serves the very next list update only, whether or not the row left with it.
    const acted = actedIdRef.current;
    actedIdRef.current = null;

    const cur = focusedIndexRef.current;
    if (cur === null) return;
    if (transactions.length === 0) { focusedIdRef.current = null; setFocusedIndex(null); return; }

    // The focused row moved (sort, filter, refresh): the index follows it, so data-focused matches DOM focus.
    const movedTo = focusedIdRef.current === null ? -1 : transactions.findIndex((t) => t.id === focusedIdRef.current);
    if (movedTo >= 0) { if (movedTo !== cur) setFocusedIndex(movedTo); return; }

    // The focused row is gone. Focus was on it, so it is now on the body (or still inside the grid).
    const active = document.activeElement;
    const focusWasHere = focusInGridRef.current && (active === document.body || !!containerRef.current?.contains(active));
    if (acted !== null && acted === focusedIdRef.current) {
      // We accepted / excluded / split it: the stream moves on, the index now points at the next row.
      const next = Math.min(cur, transactions.length - 1);
      focusedIdRef.current = transactions[next]?.id ?? null;
      if (next !== cur) setFocusedIndex(next);
      if (focusWasHere) focusRow(next);
      return;
    }
    // A filter or refresh took it: no row is picked for the user, or a reflexive Enter would accept an unseen one.
    // The grid itself takes the focus, where only the arrows act.
    focusedIdRef.current = null;
    setFocusedIndex(null);
    if (focusWasHere) containerRef.current?.focus();
  }, [transactions, focusRow]);

  /** A row is "acted on" only when its handler's promise says it was really posted, excluded or split. */
  const markWhenDone = useCallback((id: string, outcome: void | Promise<boolean>) => {
    if (!outcome) return;
    outcome.then((done) => { if (done) actedIdRef.current = id; }, (err: unknown) => log.warn('Bank row action rejected', { error: err }, 'banking'));
  }, []);

  const registerRow = useCallback((index: number, el: HTMLTableRowElement | null) => {
    rowRefs.current[index] = el;
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (transactions.length === 0 || isDropdownKey(e)) return;
    // Ctrl/Cmd/Alt chords are the browser's and the page's (Ctrl+S, Ctrl+X, Cmd+E ...), never row hotkeys.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Row hotkeys belong to the row itself (or, for the arrow that enters the stream, the grid). A key pressed on
    // anything inside a row (a button, checkbox, link, field) is that control's own: Enter on a Notes button must not
    // accept whichever row happens to be focused, and X in a field is a letter. Only Escape pops out of a field.
    const target = e.target as HTMLElement;
    const rowIndex = rowRefs.current.indexOf(target as HTMLTableRowElement);
    if (target !== e.currentTarget && rowIndex < 0) {
      const own = target.closest('tr');
      const ownIndex = own ? rowRefs.current.indexOf(own) : -1;
      if (e.key === 'Escape' && isTypingTarget(document.activeElement) && ownIndex >= 0) {
        e.preventDefault();
        setFocus(ownIndex, transactions[ownIndex]?.id);
        (document.activeElement as HTMLElement | null)?.blur();
        focusRow(ownIndex);
      }
      return;
    }
    // The grid itself takes only the arrows: after a click on empty grid space or a Shift+Tab, Enter and X would
    // otherwise act on whichever row the stream last held.
    if (target === e.currentTarget && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (rowIndex >= 0 && rowIndex !== focusedIndex) return; // a row that is not the stream's current one
    if (focusedIndex === null) {
      // Nothing focused yet: only an arrow key enters the stream (focus row 0).
      // canAccept is passed false here purely because no row is selected — it is
      // irrelevant since we only act on 'next'/'prev' below, never 'accept'.
      const entryAction = resolveBankTxKey(e.key, { isEditingCell: isTypingTarget(document.activeElement), canAccept: false });
      if (entryAction === 'next' || entryAction === 'prev') {
        e.preventDefault();
        setFocus(0, transactions[0]?.id);
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
    // A key held down repeats: one accept, exclude or split per press, never a chain over refocused rows.
    if (e.repeat && (action === 'accept' || action === 'exclude' || action === 'split' || action === 'edit')) return;

    switch (action) {
      case 'next': {
        const ni = Math.min(index + 1, transactions.length - 1);
        setFocus(ni, transactions[ni]?.id); focusRow(ni); break;
      }
      case 'prev': {
        const pi = Math.max(index - 1, 0);
        setFocus(pi, transactions[pi]?.id); focusRow(pi); break;
      }
      case 'accept':  markWhenDone(tx.id, onAccept(tx.id)); break;
      case 'exclude': markWhenDone(tx.id, onExclude(tx.id)); break;
      case 'split':   markWhenDone(tx.id, onSplit(tx.id)); break;
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
  }, [transactions, rowSelections, focusedIndex, focusRow, setFocus, markWhenDone, onAccept, onExclude, onSplit]);

  const containerProps = useMemo(() => ({
    onKeyDown,
    ref: containerRef,
    onFocus: () => { focusInGridRef.current = true; },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusInGridRef.current = false;
    },
  }), [onKeyDown]);

  const getRowProps = (index: number): RowProps => ({
    ref: (el: HTMLTableRowElement | null) => registerRow(index, el),
    tabIndex: -1,
    'data-focused': focusedIndex === index ? true : undefined,
    onClick: () => setFocus(index, transactions[index]?.id),
  });

  return { focusedIndex, containerProps, getRowProps };
}
