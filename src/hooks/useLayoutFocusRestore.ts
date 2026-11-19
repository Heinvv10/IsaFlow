/**
 * Keeps the focused field when a form swaps one element tree for another (a table row for a stacked card). The two
 * trees are different DOM, so React remounts the inputs and the browser drops focus and caret. Mark each line
 * `data-line-key` and each control's cell `data-field`; spread `handlers` on the container; pass something that
 * changes with the layout as `layoutKey`. After a swap the same line's same field is focused again, caret included.
 * It only acts when the swap left nothing focused, and forgets the field once focus goes elsewhere on purpose.
 */
import { useEffect, useLayoutEffect, useRef, type FocusEvent } from 'react';

interface Held { root: HTMLElement; key: string; field: string; el: HTMLElement }
const FOCUSABLE = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useLayoutFocusRestore(layoutKey: unknown): { onFocus: (e: FocusEvent<HTMLElement>) => void } {
  const held = useRef<Held | null>(null);
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const key = target.closest('[data-line-key]')?.getAttribute('data-line-key');
    const field = target.closest('[data-field]')?.getAttribute('data-field');
    if (!key || !field) { held.current = null; return; }
    held.current = { root: e.currentTarget, key, field, el: target };
  };
  useEffect(() => {
    // A click on something that takes no focus drops focus for good: do not bring it back later.
    const forget = (e: MouseEvent) => { if (held.current && !held.current.root.contains(e.target as Node)) held.current = null; };
    document.addEventListener('mousedown', forget);
    return () => document.removeEventListener('mousedown', forget);
  }, []);
  useBeforePaint(() => {
    const h = held.current;
    if (!h || !h.root.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const cell = [...h.root.querySelectorAll('[data-line-key]')].find((r) => r.getAttribute('data-line-key') === h.key)
      ?.querySelectorAll('[data-field]');
    const target = [...(cell ?? [])].find((c) => c.getAttribute('data-field') === h.field)?.querySelector<HTMLElement>(FOCUSABLE);
    if (!target) return;
    target.focus();
    // The old input is detached but still holds its caret: read it now, not when focus arrived.
    const was = h.el;
    if (target instanceof HTMLInputElement && was instanceof HTMLInputElement && was.selectionStart !== null && was.selectionEnd !== null) {
      target.setSelectionRange(was.selectionStart, was.selectionEnd);
    }
    held.current = { ...h, el: target };
  }, [layoutKey]);
  return { onFocus };
}
