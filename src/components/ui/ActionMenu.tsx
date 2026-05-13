/**
 * ActionMenu — Keyboard-accessible kebab dropdown for overflow actions.
 * WORKING: Portal-based, Esc to close, arrow-key navigation, click-outside close.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface ActionMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'destructive';
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  /** Accessible label for the trigger button */
  triggerLabel?: string;
  className?: string;
}

interface MenuPortalProps {
  anchorRect: DOMRect;
  items: ActionMenuItem[];
  focusedIndex: number;
  onSelect: (item: ActionMenuItem) => void;
  onFocusChange: (index: number) => void;
  menuRef: React.RefObject<HTMLDivElement>;
}

function MenuPortal({ anchorRect, items, focusedIndex, onSelect, onFocusChange, menuRef }: MenuPortalProps) {
  const top = anchorRect.bottom + window.scrollY + 4;
  // Align to the right edge of the trigger
  const right = window.innerWidth - anchorRect.right - window.scrollX;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-orientation="vertical"
      style={{
        position: 'absolute',
        top,
        right,
        minWidth: 180,
        zIndex: 9999,
      }}
      className="rounded-lg shadow-xl border py-1 bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)]"
    >
      {items.map((item, idx) => (
        <button
          key={item.label}
          role="menuitem"
          type="button"
          disabled={item.disabled}
          tabIndex={-1}
          onMouseEnter={() => onFocusChange(idx)}
          onClick={() => onSelect(item)}
          className={cn(
            'w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors',
            'disabled:opacity-40 disabled:pointer-events-none',
            item.tone === 'destructive'
              ? idx === focusedIndex
                ? 'bg-red-500/15 text-red-400'
                : 'text-red-400 hover:bg-red-500/10'
              : idx === focusedIndex
              ? 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]'
              : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] hover:text-[var(--ff-text-primary)]',
          )}
        >
          {item.icon && <span className="flex-shrink-0 h-4 w-4 flex items-center">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function ActionMenu({ items, triggerLabel = 'More actions', className }: ActionMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [focusedIndex, setFocusedIndex] = React.useState(-1);
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click — excludes both the trigger AND the portal menu itself
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        menuRef.current && !menuRef.current.contains(target)
      ) {
        setOpen(false);
        setFocusedIndex(-1);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reposition on resize / scroll while menu is open
  React.useEffect(() => {
    if (!open) return;
    const update = () => {
      if (triggerRef.current) {
        setAnchorRect(triggerRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, { capture: true });
    };
  }, [open]);

  // Keyboard navigation
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setFocusedIndex(-1);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex(i => Math.min(i + 1, items.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && focusedIndex >= 0) {
        const item = items[focusedIndex];
        if (item && !item.disabled) {
          item.onClick();
          setOpen(false);
          setFocusedIndex(-1);
          triggerRef.current?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, focusedIndex, items]);

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      setAnchorRect(triggerRef.current.getBoundingClientRect());
    }
    setOpen(o => !o);
    setFocusedIndex(-1);
  };

  const handleSelect = (item: ActionMenuItem) => {
    if (!item.disabled) item.onClick();
    setOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  };

  return (
    <div className={cn('relative inline-flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={handleToggle}
        className={cn(
          'inline-flex items-center justify-center h-9 w-9 rounded-lg',
          'border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]',
          'hover:bg-[var(--ff-bg-tertiary)] hover:text-[var(--ff-text-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
          'transition-colors',
          open && 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]',
        )}
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && anchorRect && (
        <MenuPortal
          anchorRect={anchorRect}
          items={items}
          focusedIndex={focusedIndex}
          onSelect={handleSelect}
          onFocusChange={setFocusedIndex}
          menuRef={menuRef}
        />
      )}
    </div>
  );
}
