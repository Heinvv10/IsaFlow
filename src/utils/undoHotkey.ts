/**
 * Ctrl or Cmd+Z takes the newest undo on offer. Toasts render at the end of <body>, past the whole page in Tab order,
 * so 8 s is not enough to Tab there. Moving focus to the button instead would turn the next Enter of the bank grid's
 * accept stream into an undo.
 *
 * Text fields keep their own Ctrl+Z, and a key pressed in a dialog stays there: the undo behind it posts a contra.
 */

const offers: Array<() => void> = []; // oldest first

function ownsTheKey(el: Element | null): boolean {
  if (!el) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
    || (el as HTMLElement).isContentEditable
    || el.closest('[role="dialog"]') !== null;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.repeat) return;
  if (ownsTheKey(e.target as Element | null)) return;
  e.preventDefault();
  offers[offers.length - 1]?.();
}

/** Puts `run` on offer until the returned function is called. */
export function offerUndoHotkey(run: () => void): () => void {
  if (offers.length === 0) document.addEventListener('keydown', onKeyDown);
  offers.push(run);
  return () => {
    offers.splice(offers.indexOf(run), 1);
    if (offers.length === 0) document.removeEventListener('keydown', onKeyDown);
  };
}
