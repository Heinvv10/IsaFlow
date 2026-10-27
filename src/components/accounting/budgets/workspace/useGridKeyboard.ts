/**
 * DOM key and mouse events → PR-A `gridReducer` (spec §5.2) → the store and its effects (commit,
 * clear, fill, undo / redo, save, announce, exit). Put `onKeyDown` on the grid element: the cell
 * editor sits inside the active cell, so its keys bubble here. A handled key is preventDefault-ed
 * (Ctrl/⌘+S included); copy / cut / paste stay unhandled so the native clipboard event fires
 * (`useGridClipboard`). After a move the focused cell (`[data-pos="r:c"]` inside `gridRef`)
 * takes DOM focus (roving tabindex); a blur never pulls focus back.
 *
 * No keyboard trap (QA-1): Tab off the FY column asks `onExit` to move focus; only when it did is the
 * Tab consumed, otherwise the browser's own Tab moves on. Shift+Tab at the first column commits any
 * draft and leaves natively. A typed amount the kit parser refuses on Enter / Tab keeps the editor
 * open on that cell (QA-4); the editor shows the reason.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { type GridAction, type GridEffect, gridReducer } from '@/modules/accounting/services/budgets/grid/keyboard';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';
import type { GridStore } from './gridStore';
import { clearCells, commitDraft, fillCells, redoLast, undoLast } from './gridCommands';

export interface GridKeyboardOptions {
  store: GridStore;
  gridRef: RefObject<HTMLElement | null>;
  /** The toolbar rounding unit: an FY-total commit spreads evenly with it. */
  roundingUnit: RoundingUnit;
  onSave(): void;
  /** Tab past the last column: move focus out of the grid and return true, or false to let the browser's Tab move on. */
  onExit?(): boolean;
}

export interface GridKeyboardHandlers {
  onKeyDown(e: ReactKeyboardEvent): void;
  onCellMouseDown(pos: Pos, shiftKey: boolean): void;
  /** Extends the range while the mouse button is held (drag select). */
  onCellMouseEnter(pos: Pos): void;
  onCellDoubleClick(pos: Pos): void;
  onDraftChange(draft: string): void;
  onEditorBlur(): void;
  /** Focus a cell through the store (dialogs returning focus): state, roving tab stop and DOM focus agree. */
  focusPos(pos: Pos): void;
}

/** A key from a cell or the cell editor; anything else in the grid (a row-actions button) keeps its own keys. */
const fromCell = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-pos],[data-grid-editor]') !== null;

export function useGridKeyboard(options: GridKeyboardOptions): GridKeyboardHandlers {
  const opts = useRef(options);
  useEffect(() => { opts.current = options; });
  const dragging = useRef(false);

  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  return useMemo<GridKeyboardHandlers>(() => {
    /** Runs the effects; reports a refused commit and whether an exit moved focus. */
    const run = (effects: readonly GridEffect[]) => {
      const { store, roundingUnit, onSave, onExit } = opts.current;
      let refused: { pos: Pos; draft: string } | null = null;
      let exitMoved: boolean | null = null;
      for (const e of effects) {
        if (refused && (e.type === 'exit' || e.type === 'save')) continue; // stay on the refused cell
        switch (e.type) {
          case 'commit':
            if (commitDraft(store, e.pos, e.draft, e.isTotal, roundingUnit) !== null) refused = { pos: e.pos, draft: e.draft };
            break;
          case 'clear': clearCells(store, e.cells); break;
          case 'fillDown': fillCells(store, 'down', e.rect); break;
          case 'fillRight': fillCells(store, 'right', e.rect); break;
          case 'undo': undoLast(store); break;
          case 'redo': redoLast(store); break;
          case 'save': onSave(); break;
          case 'announce': store.announce(e.message); break;
          case 'exit': exitMoved = onExit?.() ?? false; break;
          case 'copy': case 'paste': break; // the native clipboard event follows (useGridClipboard)
        }
      }
      return { refused, exitMoved };
    };

    const focusCell = (p: Pos) => {
      opts.current.gridRef.current?.querySelector<HTMLElement>(`[data-pos="${p.r}:${p.c}"]`)?.focus();
    };

    const dispatch = (action: GridAction): boolean => {
      const { store } = opts.current;
      const prev = store.getGridState();
      const res = gridReducer(prev, action, store.gridContext());
      store.setGridState(res.state);
      const { refused, exitMoved } = run(res.effects);
      if (refused && action.type === 'key') {
        // Keep the editor open on the refused cell with the text as typed.
        store.setGridState({ ...res.state, focus: refused.pos, anchor: refused.pos, mode: 'edit', draft: refused.draft, editOrigin: prev.editOrigin ?? 'type' });
        return true;
      }
      if (exitMoved === false) {
        // Nowhere to go: give focus to the cell (the editor may be gone) and let the browser's Tab move on.
        focusCell(res.state.focus);
        return false;
      }
      // A blur means focus went elsewhere on purpose (the save bar, a dialog): never pull it back.
      // In edit mode the editor input holds focus; Tab off the grid hands it to `onExit`.
      if (action.type !== 'blur' && action.type !== 'draft' && res.state.mode === 'nav' && exitMoved === null) {
        focusCell(res.state.focus);
      }
      return res.handled;
    };

    return {
      onKeyDown(e) {
        if (e.nativeEvent.isComposing || !fromCell(e.target)) return;
        if (e.key === 'Tab' && e.shiftKey && opts.current.store.getGridState().focus.c === 0) {
          // First column: commit any draft, put focus on the cell, and let Shift+Tab leave natively.
          dispatch({ type: 'blur' });
          focusCell(opts.current.store.getGridState().focus);
          return;
        }
        const handled = dispatch({ type: 'key', key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
        if (handled) e.preventDefault();
      },
      onCellMouseDown(pos, shiftKey) {
        dragging.current = true;
        dispatch({ type: 'click', pos, shift: shiftKey });
      },
      onCellMouseEnter(pos) {
        if (dragging.current) dispatch({ type: 'drag', pos });
      },
      onCellDoubleClick(pos) { dispatch({ type: 'dblclick', pos }); },
      onDraftChange(draft) { dispatch({ type: 'draft', draft }); },
      onEditorBlur() { dispatch({ type: 'blur' }); },
      focusPos(pos) {
        if (dispatch({ type: 'click', pos })) return;
        focusCell(opts.current.store.getGridState().focus);
      },
    };
  }, []);
}
