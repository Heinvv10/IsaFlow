/**
 * useFocusTrap — while `active`, keep Tab inside `containerRef`, close on Escape, move focus in
 * on open and put it back where it was on close.
 *
 * Why this exists beside Modal's inline trap: that one is a React onKeyDown on the dialog, so it never sees
 * focus that has already left it, and it is welded to Modal's markup. Rewriting Modal in this foundation PR
 * would change the behaviour of every modal in the app, so Modal keeps its own and new overlays use this.
 *
 * Keys are ignored while focus is in another dialog (the command palette over a drawer): every trap listens on document,
 * so stopPropagation cannot separate them, and both would close on Escape and fight over Tab.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return undefined;
    const previous = document.activeElement;
    const items = (): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (items()[0] ?? container).focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      const holder = document.activeElement?.closest('[role="dialog"]');
      if (holder && !holder.contains(container)) return;
      if (e.key === 'Escape') {
        // An open Select (a combobox with a popup list) inside the overlay (M14's mention picker in a drawer) closes its own list first: Escape
        // must not also close the overlay under it. The listbox is portalled, so focus is on the trigger or the list.
        const a = document.activeElement;
        // A text box that holds something keeps its Escape (it cancels the edit or leaves the box; data-keeps-escape):
        // the draft must not go with the overlay. The attribute must be present ONLY while the field holds content:
        // an empty one lets Escape close the overlay as before.
        if (a?.closest('[data-keeps-escape="true"]')) return;
        if (a?.closest('[data-select-panel="true"]') || a?.closest('[role="combobox"][aria-haspopup="listbox"][aria-expanded="true"]')) return;
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // Tab from an open Select's portalled panel (its list or search box): the Select refocuses its trigger and the browser's
      // Tab moves on from THERE. So the trigger, not the panel, is where the wrap rule looks: a Select that is the drawer's last
      // control (first, with Shift+Tab) must wrap like any other, or focus leaves the modal.
      const panel = document.activeElement?.closest('[data-select-panel="true"]');
      let current = document.activeElement;
      if (panel) {
        const listboxId = panel.querySelector('[role="listbox"]')?.id;
        const owner = listboxId ? Array.from(container.querySelectorAll<HTMLElement>('[role="combobox"][aria-controls]')).find((c) => c.getAttribute('aria-controls') === listboxId) : undefined;
        if (!owner) return; // a Select of another overlay: not this trap's
        current = owner;
      }
      const list = items();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const target = e.shiftKey ? (current === first || !container.contains(current) ? last : null)
        : (current === last || !container.contains(current) ? first : null);
      if (!target) return;
      e.preventDefault();
      if (panel) {
        // The Select's own Tab handler runs after this one and puts focus back on its trigger: move on once it has.
        setTimeout(() => target.focus(), 0);
      } else {
        target.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [active, containerRef]);
}
