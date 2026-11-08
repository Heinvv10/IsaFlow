/**
 * Select — searchable dropdown with keyboard navigation, portal, multi-select.
 * // WORKING: Portal-based dropdown, full a11y, arrow/enter/escape keyboard nav
 */

import { useState, useRef, useEffect, useCallback, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { SelectDropdown, selectOptionId } from './SelectDropdown';
import { useSelectKeyboard } from './useSelectKeyboard';
import { placePanel, type PanelPlacement } from './panelPlacement';

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SelectBaseProps {
  options: SelectOption[];
  placeholder?: string;
  searchable?: boolean;
  label?: string;
  error?: string;
  disabled?: boolean;
  clearable?: boolean;
  className?: string;
  id?: string;
  /**
   * Server-driven search: called with every keystroke in the search box. When set, `options` is NOT filtered
   * locally - the caller owns the result set (see pickers/useRemoteOptions). Implies `searchable`.
   */
  onSearch?: (query: string) => void;
  /** Called when the dropdown opens (true) or closes (false). */
  onOpenChange?: (open: boolean) => void;
  /** A request for `options` is in flight. */
  loading?: boolean;
  /** `options` could not be loaded: shown instead of the list, and no create action is offered. */
  loadError?: string | null;
  /** Adds a trailing "+ <createLabel> "<query>"" row; picking it calls this with the trimmed search text. */
  onCreateNew?: (query: string) => void;
  createLabel?: string;
  /** Single select only: how to show `value` when it is not among `options` (e.g. outside the loaded page). */
  valueOption?: SelectOption | null;
  emptyText?: string;
  /** A note under the list, e.g. "Showing the first 20 - type to narrow". */
  hint?: string;
  /** Replaces the default label classes (merged, so a later size/spacing class wins) to match a neighbouring form's labels. */
  labelClassName?: string;
  /** The id of text that describes the current value, e.g. a note under the field. */
  describedBy?: string;
  /** `sm` is a compact trigger (32px, text-xs) for grid cells; `xs` is the densest (24px, the WCAG 2.5.8 minimum); the default is the form size. */
  size?: 'xs' | 'sm' | 'md';
}

const CREATE_VALUE = '__select_create_new__';
/** A compact trigger sits in a narrow grid cell: its option panel is never narrower than this, so labels read whole. */
const COMPACT_PANEL_MIN_WIDTH = 224;
/** The panel's natural height (search box + a 240px list): below this much room it opens upward instead. */
const PANEL_WANTED_HEIGHT = 300;

interface SingleSelectProps extends SelectBaseProps {
  multiple?: false;
  value: string | null;
  onChange: (value: string | null) => void;
}

interface MultiSelectProps extends SelectBaseProps {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
}

export type SelectProps = SingleSelectProps | MultiSelectProps;

// WORKING: Select component (single and multi-select)
export function Select(props: SelectProps) {
  const { options, placeholder = 'Select…', label, error, disabled = false, clearable = false, className, id: externalId } = props;
  const { onSearch, onOpenChange, loading = false, loadError = null, onCreateNew, createLabel = 'Create new', valueOption, emptyText, hint, labelClassName, describedBy, size = 'md' } = props;
  const searchable = props.searchable === true || onSearch !== undefined;

  const autoId = useId();
  const inputId = externalId ?? autoId;
  const labelId = `${inputId}-label`;
  const listboxId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; width: number } & PanelPlacement>({ top: 0, left: 0, width: 0, maxHeight: 0 });

  const triggerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const isMulti = props.multiple === true;
  const selectedValues: string[] = isMulti ? (props.value as string[]) : props.value ? [props.value as string] : [];
  const matching = searchable && !onSearch && search.trim() ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())) : options;
  const canCreate = onCreateNew !== undefined && !loading && !loadError;
  const filteredOptions: SelectOption[] = canCreate
    ? [...matching, { value: CREATE_VALUE, label: search.trim() ? `+ ${createLabel} "${search.trim()}"` : `+ ${createLabel}…` }]
    : matching;
  // The active option is held by VALUE, so options changing while the list is open keep the highlight on it.
  const indexOf = (v: string | null) => (v === null ? -1 : filteredOptions.findIndex((o) => o.value === v));
  const activeIndex = indexOf(activeValue);
  const setActiveIndex = (u: number | ((i: number) => number)) =>
    setActiveValue((prev) => filteredOptions[typeof u === 'function' ? u(indexOf(prev)) : u]?.value ?? null);

  const recalculate = useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    // A panel wider than its trigger (compact size) is pulled back inside the viewport instead of running off its right edge.
    const compact = size !== 'md';
    const panelWidth = Math.max(r.width, compact ? COMPACT_PANEL_MIN_WIDTH : 0);
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - panelWidth - 8));
    setPos({ ...placePanel(r, window.innerHeight, PANEL_WANTED_HEIGHT), left, width: r.width });
  }, [size]);

  const closeDropdown = useCallback(() => { setOpen(false); setSearch(''); setActiveValue(null); }, []);
  const openDropdown = useCallback(() => { if (disabled) return; recalculate(); setOpen(true); setActiveValue(null); }, [disabled, recalculate]);

  function closeAndRefocus() { closeDropdown(); triggerRef.current?.focus(); }

  function selectOption(option: SelectOption) {
    if (option.disabled) return;
    if (option.value === CREATE_VALUE) { onCreateNew?.(search.trim()); closeAndRefocus(); return; }
    if (isMulti) {
      const cur = props.value as string[];
      (props as MultiSelectProps).onChange(cur.includes(option.value) ? cur.filter((v) => v !== option.value) : [...cur, option.value]);
    } else {
      (props as SingleSelectProps).onChange(option.value);
      closeAndRefocus();
    }
  }

  function clearSelection(e: React.MouseEvent) {
    e.stopPropagation();
    isMulti ? (props as MultiSelectProps).onChange([]) : (props as SingleSelectProps).onChange(null);
    triggerRef.current?.focus(); // the clear button unmounts while focused; keep keyboard focus on the trigger
  }

  const { onTriggerKeyDown, onListKeyDown } = useSelectKeyboard({
    open, searchable, options: filteredOptions, selectedValues, activeIndex, setActiveIndex, openDropdown, closeDropdown, closeAndRefocus, selectOption,
    seedSearch: (text) => { openDropdown(); setSearch(text); setActiveValue(null); onSearch?.(text); },
  });

  useEffect(() => {
    if (!listRef.current || activeIndex < 0) return;
    (listRef.current.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; });
  useEffect(() => { onOpenChangeRef.current?.(open); }, [open]);

  useEffect(() => { if (open && searchable && searchRef.current) { const box = searchRef.current; box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    // The panel is portalled out of the trigger: a press inside it is not outside. Closing here would unmount the option before its click.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current && !triggerRef.current.contains(target) && !panelRef.current?.contains(target)) closeDropdown();
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, closeDropdown]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', recalculate, true);
    window.addEventListener('resize', recalculate);
    return () => { window.removeEventListener('scroll', recalculate, true); window.removeEventListener('resize', recalculate); };
  }, [open, recalculate]);

  // The panel is positioned from the trigger's box: results arriving, an error line or a hint can move the trigger.
  useEffect(() => { if (open) recalculate(); }, [open, options, loading, loadError, error, recalculate]);

  const selectedLabels = selectedValues
    .map((v) => options.find((o) => o.value === v)?.label ?? (valueOption?.value === v ? valueOption.label : undefined))
    .filter(Boolean) as string[];
  const hasClear = clearable && selectedValues.length > 0;

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label id={labelId} htmlFor={inputId} onClick={() => triggerRef.current?.focus()} className={cn('mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300', labelClassName)}>
          {label}
        </label>
      )}
      <div
        ref={triggerRef}
        id={inputId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-labelledby={label ? labelId : undefined}
        aria-activedescendant={open && !searchable && filteredOptions[activeIndex] ? selectOptionId(inputId, activeIndex) : undefined}
        aria-describedby={describedBy}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 rounded-lg border transition-colors ff-focus-ring',
          size === 'xs' ? 'min-h-[24px] px-2 py-0 text-xs' : size === 'sm' ? 'min-h-[32px] px-2.5 py-1 text-xs' : 'min-h-[40px] px-3 py-2 text-sm',
          'bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100',
          error ? 'border-red-400 dark:border-red-500' : 'border-gray-300 dark:border-gray-600',
          !disabled && 'hover:border-teal-400 dark:hover:border-teal-500',
          open && !error && 'border-teal-500 ring-2 ring-teal-500/20',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        <span className={cn('flex flex-1 gap-1 overflow-hidden', size !== 'md' ? 'min-w-0 flex-nowrap' : 'flex-wrap')}>
          {selectedLabels.length === 0 ? (
            <span className={cn('text-gray-600 dark:text-gray-400', size !== 'md' && 'min-w-0 truncate')}>{placeholder}</span>
          ) : isMulti ? (
            selectedLabels.map((lbl) => (
              <span key={lbl} className="inline-flex items-center rounded-md bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900/50 dark:text-teal-300">{lbl}</span>
            ))
          ) : (
            <span className={cn(size !== 'md' && 'min-w-0 truncate')}>{selectedLabels[0]}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {hasClear && (
            <button type="button" aria-label="Clear selection" onClick={clearSelection} className="rounded p-0.5 text-gray-600 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={14} aria-hidden="true" />
            </button>
          )}
          <ChevronDown size={16} aria-hidden="true" className={cn('text-gray-400 transition-transform duration-200', open && 'rotate-180')} />
        </span>
      </div>
      {error && <p className="mt-1 text-xs text-red-500 dark:text-red-400" role="alert">{error}</p>}
      {typeof window !== 'undefined' && open
        ? createPortal(
            <SelectDropdown
              options={filteredOptions}
              selectedValues={selectedValues}
              activeIndex={activeIndex}
              searchable={searchable}
              search={search}
              listboxId={listboxId}
              labelId={labelId}
              inputId={inputId}
              isMulti={isMulti}
              pos={pos}
              minWidth={size !== 'md' ? COMPACT_PANEL_MIN_WIDTH : undefined}
              searchRef={searchRef}
              listRef={listRef}
              panelRef={panelRef}
              onSearchChange={(v) => { setSearch(v); setActiveValue(null); onSearch?.(v); }}
              searchLabel={label ? `Search ${label}` : undefined}
              emptyText={emptyText}
              hint={hint}
              loading={loading}
              loadError={loadError}
              onSelect={selectOption}
              onActiveChange={setActiveIndex}
              onKeyDown={onListKeyDown}
            />,
            document.body
          )
        : null}
    </div>
  );
}
