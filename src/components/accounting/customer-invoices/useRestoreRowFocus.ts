/**
 * useRestoreRowFocus - when a row-opened drawer closes, focus goes back to the row that opened it.
 *
 * The drawer's own focus trap hands focus back to whatever held it when it opened. A click on a plain table cell
 * focuses nothing, so that is BODY and the keyboard user starts again from the top of the page. Call `remember(row)`
 * when opening (the row carries `data-row-id`); once `openId` is null again focus goes, unless something else already
 * holds it (a click on the number focuses its link, which the trap restores itself):
 *   1. the remembered row, if still in the page;
 *   2. else the row now carrying the same `data-row-id` (the list refetched or re-rendered under the open drawer);
 *   3. else the remembered row's table (the row left the list, e.g. a sort or filter), which is made focusable;
 *   4. else nothing.
 */
import { useEffect, useRef } from 'react';

interface Remembered { row: HTMLElement; id: string | null; table: HTMLElement | null }

function target(r: Remembered): HTMLElement | null {
  if (r.row.isConnected) return r.row;
  if (r.id !== null) {
    const same = Array.from(document.querySelectorAll<HTMLElement>('[data-row-id]')).find((el) => el.dataset.rowId === r.id);
    if (same) return same;
  }
  return r.table?.isConnected ? r.table : null;
}

export function useRestoreRowFocus(openId: string | null): (row: HTMLElement) => void {
  const opener = useRef<Remembered | null>(null);
  useEffect(() => {
    if (openId !== null) return;
    const r = opener.current;
    opener.current = null;
    if (!r || (document.activeElement && document.activeElement !== document.body)) return;
    const el = target(r);
    if (!el) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus();
  }, [openId]);
  return (row) => { opener.current = { row, id: row.dataset.rowId ?? null, table: row.closest('table') }; };
}
