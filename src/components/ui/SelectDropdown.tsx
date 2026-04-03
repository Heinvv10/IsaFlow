/**
 * SelectDropdown — internal portal dropdown panel for the Select component.
 * Not exported from the public component library — used only by Select.tsx.
 */

import React, { type KeyboardEvent, type RefObject } from 'react';
import { Check, Search } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { SelectOption } from './Select';

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
  pos: { top: number; left: number; width: number };
  searchRef: RefObject<HTMLInputElement>;
  listRef: RefObject<HTMLUListElement>;
  onSearchChange: (value: string) => void;
  onSelect: (option: SelectOption) => void;
  onActiveChange: (index: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void;
}

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
  searchRef,
  listRef,
  onSearchChange,
  onSelect,
  onActiveChange,
  onKeyDown,
}: SelectDropdownProps) {
  return (
    <div
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      className={cn(
        'fixed z-[9999] flex flex-col overflow-hidden rounded-lg',
        'border border-gray-200 bg-white shadow-lg',
        'dark:border-gray-700 dark:bg-gray-900'
      )}
    >
      {searchable && (
        <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          <div className="flex items-center gap-2 text-gray-400">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search…"
              aria-label="Search options"
              className="flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
            />
          </div>
        </div>
      )}

      <ul
        ref={listRef as React.RefObject<HTMLUListElement>}
        id={listboxId}
        role="listbox"
        aria-multiselectable={isMulti}
        aria-labelledby={labelId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="max-h-60 overflow-y-auto py-1 focus:outline-none"
      >
        {options.length === 0 ? (
          <li className="px-3 py-2 text-sm text-gray-400">No options</li>
        ) : (
          options.map((option, i) => {
            const isSelected = selectedValues.includes(option.value);
            const isActive = activeIndex === i;
            return (
              <li
                key={option.value}
                id={`${inputId}-option-${option.value}`}
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
            );
          })
        )}
      </ul>
    </div>
  );
}
