/**
 * SelectDropdown — internal portal dropdown panel for the Select component.
 * Not exported from the public component library — used only by Select.tsx.
 */

import { Fragment, type KeyboardEvent, type RefObject } from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { SelectOption } from './Select';
import type { PanelPlacement } from './panelPlacement';
import { groupHeadingAt, SelectGroupHeading } from './selectGroups';

interface SelectDropdownProps {
  options: SelectOption[];
  selectedValues: string[];
  activeIndex: number;
  searchable: boolean;
  search: string;
  listboxId: string;
  labelId: string;
  inputId: string;
  isMulti: boolean;
  pos: { left: number; width: number } & PanelPlacement;
  /** The panel is at least this wide (px), whatever the trigger's width. */
  minWidth?: number;
  searchRef: RefObject<HTMLInputElement>;
  listRef: RefObject<HTMLUListElement>;
  panelRef: RefObject<HTMLDivElement>;
  onSearchChange: (value: string) => void;
  onSelect: (option: SelectOption) => void;
  onActiveChange: (index: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  /** Accessible name of the search box (default "Search options"). */
  searchLabel?: string;
  /** Text shown when `options` is empty and nothing is loading or failed (default "No options"). */
  emptyText?: string;
  /** A request is in flight: shown as a status line, existing options stay visible. */
  loading?: boolean;
  /** The options could not be loaded: replaces the list with an alert (an empty list would read as "no results"). */
  loadError?: string | null;
  /** A note under the list. */
  hint?: string;
}

/** The DOM id of option `index`: by position, since a value can hold characters an id cannot. */
export const selectOptionId = (inputId: string, index: number): string => `${inputId}-option-${index}`;

export function SelectDropdown({
  options,
  selectedValues,
  activeIndex,
  searchable,
  search,
  listboxId,
  labelId,
  inputId,
  isMulti,
  pos,
  minWidth,
  searchRef,
  listRef,
  panelRef,
  onSearchChange,
  onSelect,
  onActiveChange,
  onKeyDown,
  searchLabel = 'Search options',
  emptyText = 'No options',
  loading = false,
  loadError = null,
  hint,
}: SelectDropdownProps) {
  const showList = !loadError && options.length > 0;
  const activeOption = options[activeIndex];
  const activeDescendant = showList && activeOption ? selectOptionId(inputId, activeIndex) : undefined;
  return (
    <div
      ref={panelRef}
      // A press in the panel must not take focus from the trigger (its keys are what drive the list); the search box keeps its own.
      onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}
      style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, minWidth, maxHeight: pos.maxHeight }}
      className={cn(
        'fixed z-[9999] flex flex-col overflow-hidden rounded-lg',
        'border border-gray-200 bg-white shadow-lg',
        'dark:border-gray-700 dark:bg-gray-900'
      )}
    >
      {searchable && (
        <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              aria-label={searchLabel}
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              className="flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-500 dark:text-gray-100 dark:placeholder:text-gray-400"
            />
          </div>
        </div>
      )}

      {loadError ? (
        <p role="alert" className="px-3 py-2 text-sm text-red-600 dark:text-red-400">{loadError}</p>
      ) : loading ? (
        <p role="status" className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">Loading…</p>
      ) : options.length === 0 ? (
        <p role="status" className="px-3 py-2 text-sm text-gray-600 dark:text-gray-400">{emptyText}</p>
      ) : null}

      <ul
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-multiselectable={isMulti}
        aria-labelledby={labelId}
        aria-busy={loading}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-activedescendant={activeDescendant}
        className={cn('max-h-60 min-h-0 overflow-y-auto py-1 focus:outline-none', !showList && 'hidden')}
      >
        {(showList ? options : []).map((option, i) => {
          const isSelected = selectedValues.includes(option.value);
          const isActive = activeIndex === i;
          const heading = groupHeadingAt(options, i);
          return (
            <Fragment key={option.value}>
            {heading && <SelectGroupHeading label={heading} />}
            <li
              id={selectOptionId(inputId, i)}
              role="option"
              aria-selected={isSelected}
              aria-disabled={option.disabled}
              onClick={() => onSelect(option)}
              onMouseEnter={() => onActiveChange(i)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                'text-gray-700 dark:text-gray-300',
                isActive && 'bg-teal-50 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
                isSelected && !isActive && 'bg-gray-50 dark:bg-gray-800',
                option.disabled && 'cursor-not-allowed opacity-50'
              )}
            >
              {option.icon && <span className="shrink-0">{option.icon}</span>}
              <span className="flex-1">{option.label}</span>
              {isSelected && (
                <Check
                  size={14}
                  aria-hidden="true"
                  className="shrink-0 text-teal-600 dark:text-teal-400"
                />
              )}
            </li>
            </Fragment>
          );
        })}
      </ul>

      {hint && !loadError && !loading && (
        <p role="status" className="border-t border-gray-200 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400">{hint}</p>
      )}
    </div>
  );
}
