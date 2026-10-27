/**
 * DOM key and mouse events → PR-A `gridReducer` (spec §5.2) → the store and its effects (commit,
 * clear, fill, undo / redo, save, announce, exit). Put `onKeyDown` on the grid element: the cell
 * editor sits inside the active cell, so its keys bubble here. A handled key is preventDefault-ed
 * (Ctrl/⌘+S included); copy / cut / paste stay unhandled so the native clipboard event fires
 * (`useGridClipboard`). After a move the focused cell (`[data-pos="r:c"]` inside `gridRef`)
 * takes DOM focus (roving tabindex); a blur never pulls focus back.
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
  /** Tab past the last column: focus leaves the grid (to the save bar). */
  onExit?(): void;
}

export interface GridKeyboardHandlers {
  onKeyDown(e: ReactKeyboardEvent): void;
  onCellMouseDown(pos: Pos, shiftKey: boolean): void;
  /** Extends the range while the mouse button is held (drag select). */
  onCellMouseEnter(pos: Pos): void;
  onCellDoubleClick(pos: Pos): void;
  onDraftChange(draft: string): void;
  onEditorBlur(): void;
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
    const run = (effects: readonly GridEffect[]) => {
      const { store, roundingUnit, onSave, onExit } = opts.current;
      for (const e of effects) {
        switch (e.type) {
          case 'commit': commitDraft(store, e.pos, e.draft, e.isTotal, roundingUnit); break;
          case 'clear': clearCells(store, e.cells); break;
          case 'fillDown': fillCells(store, 'down', e.rect); break;
          case 'fillRight': fillCells(store, 'right', e.rect); break;
          case 'undo': undoLast(store); break;
          case 'redo': redoLast(store); break;
          case 'save': onSave(); break;
          case 'announce': store.announce(e.message); break;
          case 'exit': onExit?.(); break;
          case 'copy': case 'paste': break; // the native clipboard event follows (useGridClipboard)
        }
      }
    };

    const focusCell = (p: Pos) => {
      opts.current.gridRef.current?.querySelector<HTMLElement>(`[data-pos="${p.r}:${p.c}"]`)?.focus();
    };

    const dispatch = (action: GridAction): boolean => {
      const { store } = opts.current;
      const prev = store.getGridState();
      const res = gridReducer(prev, action, store.gridContext());
      store.setGridState(res.state);
      run(res.effects);
      // A blur means focus went elsewhere on purpose (the save bar, a dialog): never pull it back.
      // In edit mode the editor input holds focus; Tab off the grid hands it to `onExit`.
      if (action.type !== 'blur' && action.type !== 'draft' && res.state.mode === 'nav' && !res.effects.some(e => e.type === 'exit')) {
        focusCell(res.state.focus);
      }
      return res.handled;
    };

    return {
      onKeyDown(e) {
        if (e.nativeEvent.isComposing || !fromCell(e.target)) return;
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
    };
  }, []);
}
