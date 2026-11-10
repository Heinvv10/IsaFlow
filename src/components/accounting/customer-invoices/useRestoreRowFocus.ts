/**
 * useRestoreRowFocus — when a row-opened drawer closes, focus goes back to the row that opened it.
 *
 * The drawer's own focus trap hands focus back to whatever held it when it opened. A click on a plain table cell
 * focuses nothing, so that is BODY and the keyboard user starts again from the top of the page. Call `remember(row)`
 * when opening; once `openId` is null again the row is focused, unless something else already holds focus (a click
 * on the number focuses its link, which the trap restores itself).
 */
import { useEffect, useRef } from 'react';

export function useRestoreRowFocus(openId: string | null): (row: HTMLElement) => void {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (openId !== null) return;
    const row = opener.current;
    opener.current = null;
    if (row?.isConnected && (!document.activeElement || document.activeElement === document.body)) row.focus();
  }, [openId]);
  return (row) => { opener.current = row; };
}
