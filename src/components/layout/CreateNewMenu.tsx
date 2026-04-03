/**
 * CreateNewMenu — Quick-create "+" button for the app header.
 *
 * Opens a dropdown of common create actions. Supports:
 *   - "N" key to open the menu (when not in a text field)
 *   - Letter keys to jump to items when the menu is open
 *   - Arrow keys for navigation, Enter to activate, Escape to close
 *   - Click-outside to close
 *   - Portal rendering to avoid z-index clipping
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/router';
import {
  Plus,
  FileText,
  Receipt,
  FileCheck,
  CreditCard,
  BookOpen,
  UserPlus,
  ArrowLeftRight,
  LucideIcon,
} from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/utils/cn';

// ─── Menu item definition ────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  icon: LucideIcon;
  route: string;
  /** Single uppercase letter shown as shortcut hint when menu is open. */
  shortcutLetter: string;
}

const MENU_ITEMS: MenuItem[] = [
  { label: 'New Invoice',       icon: FileText,        route: '/accounting/customer-invoices?action=new', shortcutLetter: 'I' },
  { label: 'New Bill',          icon: Receipt,         route: '/accounting/supplier-invoices?action=new', shortcutLetter: 'B' },
  { label: 'New Quote',         icon: FileCheck,       route: '/accounting/customer-quotes?action=new',   shortcutLetter: 'Q' },
  { label: 'Record Payment',    icon: CreditCard,      route: '/accounting/customer-payments/new',        shortcutLetter: 'P' },
  { label: 'New Journal Entry', icon: BookOpen,        route: '/accounting/journal-entries/new',          shortcutLetter: 'J' },
  { label: 'New Contact',       icon: UserPlus,        route: '/accounting/customers/new',                shortcutLetter: 'C' },
  { label: 'Bank Transfer',     icon: ArrowLeftRight,  route: '/accounting/bank-transfers?action=new',    shortcutLetter: 'T' },
];

// Map shortcut letter → index for quick lookup
const LETTER_MAP: Record<string, number> = Object.fromEntries(
  MENU_ITEMS.map((item, i) => [item.shortcutLetter.toLowerCase(), i])
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

// ─── Dropdown portal ─────────────────────────────────────────────────────────

interface DropdownProps {
  anchorRect: DOMRect;
  focusedIndex: number;
  onSelect: (route: string) => void;
  onFocusChange: (index: number) => void;
}

function Dropdown({ anchorRect, focusedIndex, onSelect, onFocusChange }: DropdownProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    itemRefs.current[focusedIndex]?.focus();
  }, [focusedIndex]);

  const top = anchorRect.bottom + window.scrollY + 8;
  const left = anchorRect.right + window.scrollX;

  return createPortal(
    <div
      role="menu"
      aria-label="Create new"
      style={{ position: 'absolute', top, left, transform: 'translateX(-100%)' }}
      className={cn(
        'z-[9999] w-64 py-1.5 rounded-xl',
        'bg-white dark:bg-gray-900',
        'border border-gray-200 dark:border-gray-700',
        'shadow-xl shadow-black/10 dark:shadow-black/40',
      )}
    >
      <p className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 select-none">
        Create New
      </p>
      {MENU_ITEMS.map((item, i) => {
        const Icon = item.icon;
        const isFocused = focusedIndex === i;
        return (
          <button
            key={item.route}
            ref={el => { itemRefs.current[i] = el; }}
            role="menuitem"
            tabIndex={isFocused ? 0 : -1}
            onClick={() => onSelect(item.route)}
            onMouseEnter={() => onFocusChange(i)}
            onFocus={() => onFocusChange(i)}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors',
              'text-gray-700 dark:text-gray-200',
              isFocused
                ? 'bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300'
                : 'hover:bg-gray-50 dark:hover:bg-gray-800',
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0 text-gray-400 dark:text-gray-500" />
            <span className="flex-1 text-left">{item.label}</span>
            <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono tabular-nums">
              N {item.shortcutLetter}
            </span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function CreateNewMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback(() => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setFocusedIndex(0);
    setOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const navigate = useCallback((route: string) => {
    setOpen(false);
    void router.push(route);
  }, [router]);

  // Global "N" key opens the menu
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (!open && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openMenu();
        return;
      }

      if (open) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFocusedIndex(i => (i + 1) % MENU_ITEMS.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFocusedIndex(i => (i - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const focused = MENU_ITEMS[focusedIndex];
          if (focused) navigate(focused.route);
          return;
        }
        // Letter shortcut
        const idx = LETTER_MAP[e.key.toLowerCase()];
        if (idx !== undefined) {
          e.preventDefault();
          const target = MENU_ITEMS[idx];
          if (target) navigate(target.route);
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, focusedIndex, openMenu, closeMenu, navigate]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // Delay one tick so the button click that opened the menu doesn't immediately close it
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [open]);

  // Recalculate anchor on scroll/resize while open
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (buttonRef.current) setAnchorRect(buttonRef.current.getBoundingClientRect());
    };
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, { capture: true });
    };
  }, [open]);

  const handleButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open ? closeMenu() : openMenu();
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      closeMenu();
    }
  };

  return (
    <>
      <Tooltip content="Create new (N)" position="bottom">
        <button
          ref={buttonRef}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Create new"
          onClick={() => open ? closeMenu() : openMenu()}
          onKeyDown={handleButtonKeyDown}
          className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors',
            open
              ? 'bg-teal-700 text-white'
              : 'bg-teal-600 hover:bg-teal-700 text-white',
          )}
        >
          <Plus className="w-4 h-4" />
        </button>
      </Tooltip>

      {open && anchorRect && (
        <Dropdown
          anchorRect={anchorRect}
          focusedIndex={focusedIndex}
          onSelect={navigate}
          onFocusChange={setFocusedIndex}
        />
      )}
    </>
  );
}
