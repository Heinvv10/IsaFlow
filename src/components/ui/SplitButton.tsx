/**
 * SplitButton — Primary action with a dropdown of secondary actions.
 * WORKING: Portal-based dropdown, keyboard nav, dark mode, ESC/click-outside close.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';
import { LoadingSpinner } from './LoadingSpinner';

export interface SplitButtonOption {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SplitButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  options: SplitButtonOption[];
  className?: string;
}

type Variant = NonNullable<SplitButtonProps['variant']>;
type Size = NonNullable<SplitButtonProps['size']>;

const MAIN_CLS: Record<Variant, string> = {
  primary: 'bg-teal-600 text-white hover:bg-teal-700 focus-visible:ring-teal-500 dark:bg-teal-500 dark:hover:bg-teal-600',
  secondary: 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus-visible:ring-teal-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 dark:bg-red-700 dark:hover:bg-red-800',
};

const CHEVRON_CLS: Record<Variant, string> = {
  primary: 'bg-teal-700 text-white hover:bg-teal-800 border-l border-teal-500 focus-visible:ring-teal-500 dark:bg-teal-600 dark:hover:bg-teal-700 dark:border-teal-400',
  secondary: 'border border-l-0 border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus-visible:ring-teal-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
  danger: 'bg-red-700 text-white hover:bg-red-800 border-l border-red-500 focus-visible:ring-red-500 dark:bg-red-800 dark:hover:bg-red-900 dark:border-red-600',
};

const SIZE_MAIN: Record<Size, string> = { sm: 'h-8 px-3 text-xs', md: 'h-9 px-4 text-sm', lg: 'h-11 px-6 text-base' };
const SIZE_CHEVRON: Record<Size, string> = { sm: 'h-8 w-7', md: 'h-9 w-8', lg: 'h-11 w-10' };
const ICON_SIZE: Record<Size, number> = { sm: 14, md: 16, lg: 18 };

const BASE = 'inline-flex items-center justify-center font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none';

// ─── Portal dropdown ──────────────────────────────────────────────────────────

interface DropdownPortalProps {
  anchorRect: DOMRect;
  options: SplitButtonOption[];
  focusedIndex: number;
  onSelect: (option: SplitButtonOption) => void;
  onFocusChange: (index: number) => void;
}

function DropdownPortal({ anchorRect, options, focusedIndex, onSelect, onFocusChange }: DropdownPortalProps) {
  const top = anchorRect.bottom + window.scrollY + 4;
  const left = anchorRect.left + window.scrollX;
  return createPortal(
    <div
      role="menu"
      aria-orientation="vertical"
      style={{ position: 'absolute', top, left, minWidth: anchorRect.width, zIndex: 9999 }}
      className="rounded-md shadow-xl border py-1 bg-white border-gray-200 dark:bg-gray-800 dark:border-gray-700"
    >
      {options.map((opt, idx) => {
        const Icon = opt.icon;
        return (
          <button
            key={opt.label}
            role="menuitem"
            disabled={opt.disabled}
            tabIndex={-1}
            onMouseEnter={() => onFocusChange(idx)}
            onClick={() => onSelect(opt)}
            className={cn(
              'w-full flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors',
              'disabled:opacity-50 disabled:pointer-events-none',
              idx === focusedIndex
                ? 'bg-teal-50 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
                : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700',
            )}
          >
            {Icon && <Icon size={14} className="flex-shrink-0" />}
            {opt.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

// ─── SplitButton ──────────────────────────────────────────────────────────────

function SplitButton({
  label, onClick, variant = 'primary', size = 'md',
  disabled = false, loading = false, options, className,
}: SplitButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [focusedIndex, setFocusedIndex] = React.useState(-1);
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const chevronRef = React.useRef<HTMLButtonElement>(null);
  const isDisabled = disabled || loading;

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false); setFocusedIndex(-1);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Keyboard navigation
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); setFocusedIndex(-1); chevronRef.current?.focus(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocusedIndex(i => Math.min(i + 1, options.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFocusedIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' && focusedIndex >= 0) {
        const opt = options[focusedIndex];
        if (opt && !opt.disabled) { opt.onClick(); setOpen(false); setFocusedIndex(-1); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, focusedIndex, options]);

  const toggleDropdown = () => {
    if (isDisabled) return;
    if (!open && wrapperRef.current) setAnchorRect(wrapperRef.current.getBoundingClientRect());
    setOpen(o => !o);
    setFocusedIndex(-1);
  };

  const handleSelect = (opt: SplitButtonOption) => {
    if (!opt.disabled) opt.onClick();
    setOpen(false); setFocusedIndex(-1);
  };

  return (
    <div ref={wrapperRef} className={cn('inline-flex rounded-md shadow-sm', className)}>
      <button
        type="button" disabled={isDisabled} aria-disabled={isDisabled} aria-busy={loading}
        onClick={onClick}
        className={cn(BASE, 'rounded-l-md rounded-r-none', SIZE_MAIN[size], MAIN_CLS[variant])}
      >
        {loading && <LoadingSpinner size={size === 'lg' ? 'md' : 'sm'} />}
        {label}
      </button>

      <button
        ref={chevronRef} type="button" disabled={isDisabled}
        aria-haspopup="menu" aria-expanded={open} aria-label="More options"
        onClick={toggleDropdown}
        className={cn(BASE, 'rounded-l-none rounded-r-md px-0', SIZE_CHEVRON[size], CHEVRON_CLS[variant])}
      >
        <ChevronDown size={ICON_SIZE[size]} className={cn('transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && anchorRect && (
        <DropdownPortal
          anchorRect={anchorRect} options={options}
          focusedIndex={focusedIndex} onSelect={handleSelect} onFocusChange={setFocusedIndex}
        />
      )}
    </div>
  );
}

SplitButton.displayName = 'SplitButton';

export { SplitButton };
