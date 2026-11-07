/**
 * useSelectKeyboard — the key handling of the kit Select's trigger and list.
 *
 * Focus stays on the trigger of a non-searchable select (a press in the panel does not take it), so the trigger
 * handler owns every key there. Enter and Space choose the active option; Tab closes without choosing; Home and End
 * jump; arrows skip disabled options. Printable keys type ahead: they move the ACTIVE option (opening the list when
 * it is closed) and never the value, which changes only on Enter, Space or a click. While a type-ahead prefix is
 * live, Space is part of it instead of a choice. A searchable select seeds its search box with a first key typed on
 * the closed trigger.
 */
import { useRef, type KeyboardEvent } from 'react';
import type { SelectOption } from './Select';

const TYPEAHEAD_RESET_MS = 700;

/** The next enabled option from `from` in `dir` (no wrap); `from` itself when there is none. */
export function nextEnabled(options: SelectOption[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i]?.disabled) return i;
  return from;
}

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
  searchable: boolean;
  options: SelectOption[];
  selectedValues: string[];
  activeIndex: number;
  setActiveIndex: (update: number | ((i: number) => number)) => void;
  openDropdown: () => void;
  closeDropdown: () => void;
  closeAndRefocus: () => void;
  selectOption: (option: SelectOption) => void;
  /** Opens a searchable list with its search box holding `text`. */
  seedSearch: (text: string) => void;
}

export function useSelectKeyboard(a: Args) {
  const typed = useRef({ text: '', at: 0 });
  const first = () => nextEnabled(a.options, -1, 1);
  const last = () => nextEnabled(a.options, a.options.length, -1);
  const selectedIndex = a.options.findIndex((o) => a.selectedValues.includes(o.value));
  const prefixIsLive = () => typed.current.text !== '' && Date.now() - typed.current.at <= TYPEAHEAD_RESET_MS;

  function choose() { const o = a.options[a.activeIndex]; if (o && !o.disabled) a.selectOption(o); }
  function openOn(index: number) { a.openDropdown(); a.setActiveIndex(index); }

  function typeAhead(key: string) {
    const text = (prefixIsLive() ? typed.current.text : '') + key;
    typed.current = { text, at: Date.now() };
    const base = a.open ? a.activeIndex : selectedIndex;
    // One letter pressed again walks the options sharing it; a longer prefix refines from where it is.
    const repeated = /^(.)\1+$/.test(text);
    const hit = findTypeahead(a.options, repeated ? text.slice(0, 1) : text, text.length === 1 || repeated ? base + 1 : Math.max(base, 0));
    if (!a.open) a.openDropdown();
    if (hit >= 0) a.setActiveIndex(hit);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return; // the clear button handles its own keys
    const k = e.key;
    if (k === ' ' && prefixIsLive()) { e.preventDefault(); typeAhead(' '); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); if (a.open) choose(); else a.openDropdown(); }
    else if (k === 'ArrowDown') { e.preventDefault(); if (a.open) a.setActiveIndex((i) => nextEnabled(a.options, i, 1)); else openOn(selectedIndex); }
    else if (k === 'ArrowUp') { e.preventDefault(); if (a.open) a.setActiveIndex((i) => (i < 0 ? first() : nextEnabled(a.options, i, -1))); else openOn(selectedIndex); }
    else if (k === 'Home') { e.preventDefault(); if (a.open) a.setActiveIndex(first()); else openOn(first()); }
    else if (k === 'End') { e.preventDefault(); if (a.open) a.setActiveIndex(last()); else openOn(last()); }
    else if (k === 'Tab' || k === 'Escape') a.closeDropdown();
    else if (k.length === 1) {
      e.preventDefault();
      if (a.searchable && !a.open) a.seedSearch(k); else typeAhead(k);
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); a.setActiveIndex((i) => nextEnabled(a.options, i, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); a.setActiveIndex((i) => (i < 0 ? first() : nextEnabled(a.options, i, -1))); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if (e.key === 'Tab') a.closeAndRefocus(); // focus returns to the trigger, then the browser's Tab moves on from it
    else if (e.key === 'Escape') a.closeAndRefocus();
  }

  return { onTriggerKeyDown, onListKeyDown };
}
