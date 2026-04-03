/**
 * Select — searchable dropdown with keyboard navigation, portal, multi-select.
 * // WORKING: Portal-based dropdown, full a11y, arrow/enter/escape keyboard nav
 */

import { useState, useRef, useEffect, useCallback, useId, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { SelectDropdown } from './SelectDropdown';

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
}

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
  const { options, placeholder = 'Select…', searchable = false, label, error, disabled = false, clearable = false, className, id: externalId } = props;

  const autoId = useId();
  const inputId = externalId ?? autoId;
  const labelId = `${inputId}-label`;
  const listboxId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });

  const triggerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const isMulti = props.multiple === true;
  const selectedValues: string[] = isMulti ? (props.value as string[]) : props.value ? [props.value as string] : [];
  const filteredOptions = searchable && search.trim() ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase())) : options;

  const recalculate = useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: r.width });
  }, []);

  const closeDropdown = useCallback(() => { setOpen(false); setSearch(''); setActiveIndex(-1); }, []);
  const openDropdown = useCallback(() => { if (disabled) return; recalculate(); setOpen(true); setActiveIndex(-1); }, [disabled, recalculate]);

  function selectOption(option: SelectOption) {
    if (option.disabled) return;
    if (isMulti) {
      const cur = props.value as string[];
      (props as MultiSelectProps).onChange(cur.includes(option.value) ? cur.filter((v) => v !== option.value) : [...cur, option.value]);
    } else {
      (props as SingleSelectProps).onChange(option.value);
      closeDropdown();
    }
  }

  function clearSelection(e: React.MouseEvent) {
    e.stopPropagation();
    isMulti ? (props as MultiSelectProps).onChange([]) : (props as SingleSelectProps).onChange(null);
  }

  function handleTriggerKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open ? setActiveIndex((i) => Math.min(i + 1, filteredOptions.length - 1)) : openDropdown(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Escape') closeDropdown();
  }

  function handleListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, filteredOptions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (activeIndex >= 0 && filteredOptions[activeIndex]) selectOption(filteredOptions[activeIndex]); }
    else if (e.key === 'Escape') closeDropdown();
  }

  useEffect(() => {
    if (!listRef.current || activeIndex < 0) return;
    (listRef.current.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => { if (open && searchable && searchRef.current) searchRef.current.focus(); }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) closeDropdown(); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, closeDropdown]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', recalculate, true);
    window.addEventListener('resize', recalculate);
    return () => { window.removeEventListener('scroll', recalculate, true); window.removeEventListener('resize', recalculate); };
  }, [open, recalculate]);

  const selectedLabels = selectedValues.map((v) => options.find((o) => o.value === v)?.label).filter(Boolean) as string[];
  const hasClear = clearable && selectedValues.length > 0;

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label id={labelId} htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
      )}
      <div
        ref={triggerRef}
        id={inputId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-owns={listboxId}
        aria-labelledby={label ? labelId : undefined}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'flex min-h-[40px] w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none',
          'bg-white text-gray-900 dark:bg-gray-800 dark:text-gray-100',
          error ? 'border-red-400 dark:border-red-500' : 'border-gray-300 dark:border-gray-600',
          !disabled && 'hover:border-teal-400 dark:hover:border-teal-500',
          open && !error && 'border-teal-500 ring-2 ring-teal-500/20',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        <span className="flex flex-1 flex-wrap gap-1 overflow-hidden">
          {selectedLabels.length === 0 ? (
            <span className="text-gray-400">{placeholder}</span>
          ) : isMulti ? (
            selectedLabels.map((lbl) => (
              <span key={lbl} className="inline-flex items-center rounded-md bg-teal-100 px-2 py-0.5 text-xs font-medium text-teal-800 dark:bg-teal-900/50 dark:text-teal-300">{lbl}</span>
            ))
          ) : (
            <span>{selectedLabels[0]}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {hasClear && (
            <button type="button" aria-label="Clear selection" onClick={clearSelection} className="rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
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
              searchRef={searchRef}
              listRef={listRef}
              onSearchChange={(v) => { setSearch(v); setActiveIndex(-1); }}
              onSelect={selectOption}
              onActiveChange={setActiveIndex}
              onKeyDown={handleListKeyDown}
            />,
            document.body
          )
        : null}
    </div>
  );
}
