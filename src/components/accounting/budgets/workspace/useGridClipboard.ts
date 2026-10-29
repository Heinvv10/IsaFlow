/**
 * Copy / cut / paste on the grid (spec §5.3) through the NATIVE ClipboardEvents (`text/plain`),
 * so no clipboard-permission API is involved and a headless browser can dispatch them. The
 * selection is the store's (anchor → focus). While a cell is being edited the editor input keeps
 * the browser's own clipboard behaviour.
 */
import { useMemo, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { normalise } from '@/modules/accounting/services/budgets/grid/selection';
import type { GridStore } from './gridStore';
import { copyText, cutText, pasteText } from './gridCommands';

export interface GridClipboardHandlers {
  onCopy(e: ReactClipboardEvent): void;
  onCut(e: ReactClipboardEvent): void;
  onPaste(e: ReactClipboardEvent): void;
}

export function useGridClipboard(store: GridStore): GridClipboardHandlers {
  return useMemo<GridClipboardHandlers>(() => {
    /** The selection when the grid (not its editor) owns the event, else null. */
    const selection = () => {
      const s = store.getGridState();
      return s.mode === 'edit' ? null : normalise(s.anchor, s.focus);
    };
    return {
      onCopy(e) {
        const rect = selection();
        if (!rect) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', copyText(store, rect));
      },
      onCut(e) {
        const rect = selection();
        if (!rect) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', cutText(store, rect));
      },
      onPaste(e) {
        const rect = selection();
        if (!rect) return;
        e.preventDefault();
        pasteText(store, rect, e.clipboardData.getData('text/plain'));
      },
    };
  }, [store]);
}
