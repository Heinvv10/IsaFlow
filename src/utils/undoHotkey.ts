/**
 * Ctrl or Cmd+Z takes the newest undo on offer. Toasts render at the end of <body>, past the whole page in Tab order,
 * so 8 s is not enough to Tab there. Moving focus to the button instead would turn the next Enter of the bank grid's
 * accept stream into an undo.
 *
 * It stands down for anyone with a better claim on the key, because the undo posts a contra. Text fields keep their own
 * Ctrl+Z, a handler that already took the key keeps it (the budget grid has an undo of its own), and an open modal holds
 * it wherever focus is: most of the bank page's modals never take focus, so the key arrives on <body>.
 */

const offers: Array<() => void> = []; // oldest first

/** A double-tap is one undo: the second press would take the next offer down the stack. */
const DOUBLE_TAP_MS = 500;
let lastRunAt = 0;

/** Inputs with no text of their own to undo. */
const NON_TEXT_INPUTS = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image'];

function ownsTheKey(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'INPUT') return !NON_TEXT_INPUTS.includes((el as HTMLInputElement).type);
  return ['TEXTAREA', 'SELECT'].includes(el.tagName)
    || (el as HTMLElement).isContentEditable
    || el.closest('[role="dialog"]') !== null;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.repeat) return;
  if (document.querySelector('[aria-modal="true"]') || ownsTheKey(e.target as Element | null)) return;
  e.preventDefault();
  const now = Date.now();
  if (now - lastRunAt < DOUBLE_TAP_MS) return;
  lastRunAt = now;
  offers[offers.length - 1]?.();
}

/** Puts `run` on offer until the returned function is called. */
export function offerUndoHotkey(run: () => void): () => void {
  if (offers.length === 0) document.addEventListener('keydown', onKeyDown);
  offers.push(run);
  return () => {
    offers.splice(offers.indexOf(run), 1);
    if (offers.length > 0) return;
    document.removeEventListener('keydown', onKeyDown);
    lastRunAt = 0;
  };
}
