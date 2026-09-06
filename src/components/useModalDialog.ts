/**
 * The keyboard contract for a modal dialog, in one place.
 *
 * Both WS3 popovers had this logic and both had the same bug: the Escape
 * listener was attached to a plain `<div>` that nothing ever focused, so the
 * key event went to `<body>` and never reached it. Escape did nothing for the
 * person who had just clicked the trigger — the exact user the handler existed
 * for — while a test that dispatched keydown ON the container passed.
 *
 * What this returns is a ref for the dialog element. Attach it, and the dialog
 * gets:
 *   - focus on mount, so a keyboard user is inside the thing that just opened
 *     and Escape reaches the listener. `tabIndex={-1}` on the element is what
 *     makes a non-interactive container focusable at all, and is the caller's
 *     job because it belongs in the JSX next to `role="dialog"`.
 *   - a Tab trap: Tab off the last control wraps to the first, Shift+Tab off
 *     the first wraps to the last, and a Tab pressed while focus has ended up
 *     OUTSIDE the dialog pulls it back in. Without it Tab walks out into the
 *     page behind the dialog, which for a keyboard user is the dialog silently
 *     ceasing to be modal while it still covers the screen.
 *   - Escape closes, from anywhere, for as long as the dialog is mounted. The
 *     listener is on `document` rather than on the dialog for a reason found in
 *     a browser: clicking Revoke removes the button that had focus, the browser
 *     drops focus to `<body>`, and a listener bound to the dialog stops hearing
 *     the key — Escape would work, then quietly stop working after an action
 *     that re-rendered the list.
 *   - focus back on whatever opened it when it unmounts. Without the restore a
 *     keyboard user is returned to the top of the document and has to tab back
 *     down the whole page.
 *
 * The focusable set is queried on every Tab rather than cached: these dialogs
 * add and remove controls as they load, and a cached list traps focus on a
 * button that is no longer there. `[hidden]` is excluded; a disabled control
 * is already excluded by the selector, which matters because both dialogs
 * disable their submit button until there is something to submit.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter(el => !el.hasAttribute('hidden'));
}

export function useModalDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    // Focus the container itself, not its first control: the dialog's own
    // accessible name is then what a screen reader announces, and no text box
    // starts out claiming the caret before the person has read anything.
    node?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (!node) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable(node);
      if (items.length === 0) {
        // Nothing to move to; keep focus in the dialog rather than letting Tab
        // walk into the page behind it.
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!(active instanceof Node) || !node.contains(active)) {
        // Focus has ended up outside — usually because the control that had it
        // was removed by a re-render. Pull it back in rather than tabbing off
        // into the page the dialog is covering.
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [onClose]);

  return ref;
}
