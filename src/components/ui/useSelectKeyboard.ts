/**
 * useSelectKeyboard — the key handling of the kit Select's trigger and list.
 *
 * Focus stays on the trigger of a non-searchable select, so the trigger handler owns every key there. Enter and
 * Space choose the active option; Tab closes without choosing; Home and End jump. Printable keys type ahead: they
 * move the ACTIVE option (opening the list when it is closed) and never the value, which changes only on Enter or a
 * click. A searchable select takes printable keys in its search box instead.
 */
import { useRef, type KeyboardEvent } from 'react';
import type { SelectOption } from './Select';

const TYPEAHEAD_RESET_MS = 700;

/** The next enabled option whose label starts with `prefix`, searching on from `from` and wrapping; -1 for none. */
export function findTypeahead(options: SelectOption[], prefix: string, from: number): number {
  const p = prefix.toLowerCase();
  for (let n = 0; n < options.length; n++) {
    const i = (from + n) % options.length;
    const o = options[i];
    if (o && !o.disabled && o.label.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

interface Args {
  open: boolean;
  options: SelectOption[];
  selectedValues: string[];
  activeIndex: number;
  setActiveIndex: (update: number | ((i: number) => number)) => void;
  openDropdown: () => void;
  closeDropdown: () => void;
  closeAndRefocus: () => void;
  selectOption: (option: SelectOption) => void;
}

export function useSelectKeyboard(a: Args) {
  const typed = useRef({ text: '', at: 0 });
  const last = a.options.length - 1;

  function choose() { const o = a.options[a.activeIndex]; if (o) a.selectOption(o); }

  function typeAhead(key: string) {
    const now = Date.now();
    const fresh = now - typed.current.at > TYPEAHEAD_RESET_MS;
    typed.current = { text: (fresh ? '' : typed.current.text) + key, at: now };
    const text = typed.current.text;
    // One letter pressed again walks the options sharing it; a longer prefix refines from where it is.
    const from = text.length === 1 || /^(.)\1+$/.test(text) ? a.activeIndex + 1 : Math.max(a.activeIndex, 0);
    const hit = findTypeahead(a.options, /^(.)\1+$/.test(text) ? text.slice(0, 1) : text, from);
    if (!a.open) a.openDropdown();
    if (hit >= 0) a.setActiveIndex(hit);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (a.open) choose(); else a.openDropdown(); }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (a.open) a.setActiveIndex((i) => Math.min(i + 1, last));
      else { a.openDropdown(); a.setActiveIndex(a.options.findIndex((o) => a.selectedValues.includes(o.value))); }
    }
    else if (e.key === 'ArrowUp') { e.preventDefault(); a.setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Home' && a.open) { e.preventDefault(); a.setActiveIndex(0); }
    else if (e.key === 'End' && a.open) { e.preventDefault(); a.setActiveIndex(last); }
    else if (e.key === 'Tab') a.closeDropdown();
    else if (e.key === 'Escape') a.closeDropdown();
    else if (e.key.length === 1) { e.preventDefault(); typeAhead(e.key); }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); a.setActiveIndex((i) => Math.min(i + 1, last)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); a.setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if (e.key === 'Tab') a.closeDropdown();
    else if (e.key === 'Escape') a.closeAndRefocus();
  }

  return { onTriggerKeyDown, onListKeyDown };
}
