/**
 * ActionMenu — a keyboard-accessible menu button (WAI-ARIA menu button pattern) for overflow actions.
 *
 * Opening it (click, Enter, Space, ArrowDown; ArrowUp opens on the last item) moves focus INTO the menu, onto an item,
 * and the items rove: one has tabIndex 0, Arrow keys / Home / End move focus. Enter and Space act on the item that HAS
 * focus when the key is pressed (read from the event, never from a remembered index), so a key can never act on an item
 * or a row the user has moved away from. Escape closes and returns focus to the trigger; Tab closes and lets focus go
 * on from the trigger; focus leaving the menu any other way, or a click outside it, closes it. The menu is fixed to the
 * viewport and opens upward when there is not room below (panelPlacement), scrolling inside when neither side fits.
 * Keys the menu handles stop there (the menu is portalled, and React would bubble them to the trigger's ancestors,
 * e.g. a grid that has hotkeys of its own).
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/utils/cn';
import { chooseSide, placePanel, type PanelPlacement } from './panelPlacement';

export interface ActionMenuItem {
  label: string;
  icon?: React.ReactNode;
  /**
   * A navigation: the item renders as a real link (new tab, middle-click and copy-link work; a click follows it natively).
   * `onClick` is still what Enter / Space run, so it should navigate to the same place.
   */
  href?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'destructive';
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  /** Accessible label for the trigger button */
  triggerLabel?: string;
  className?: string;
  /** What the trigger shows (default: the kebab icon). Text here also becomes the trigger's visible label. */
  trigger?: React.ReactNode;
  /** The trigger's size classes (default: 36px square, 44px below lg). */
  triggerSizeClassName?: string;
  /** The trigger's tooltip (default: none). */
  triggerTitle?: string;
}

/** One item's height (py-2, text-sm) and the menu's padding: the height the menu wants when it opens. */
const ITEM_PX = 36;
const MENU_PAD_PX = 8;

const enabledIndexes = (items: ActionMenuItem[]): number[] => items.flatMap((it, i) => (it.disabled ? [] : [i]));

export function ActionMenu({
  items, triggerLabel = 'More actions', className, trigger, triggerSizeClassName = 'h-9 w-9 max-lg:h-11 max-lg:w-11', triggerTitle,
}: ActionMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [place, setPlace] = React.useState<{ p: PanelPlacement; right: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  /** An item element by its index (data-menu-index): links and buttons alike, without relying on refs reaching an <a>. */
  const itemAt = (i: number) => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${i}"]`) ?? null;
  const indexOf = (el: EventTarget | null) => Number((el as HTMLElement | null)?.closest?.('[data-menu-index]')?.getAttribute('data-menu-index') ?? -1);

  const measure = React.useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const side = chooseSide(r, window.innerHeight, items.length * ITEM_PX + MENU_PAD_PX);
    setPlace({ p: placePanel(r, window.innerHeight, side), right: window.innerWidth - r.right });
  }, [items.length]);

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openAt = (which: 'first' | 'last') => {
    const enabled = enabledIndexes(items);
    measure();
    setActive(which === 'first' ? enabled[0] ?? -1 : enabled[enabled.length - 1] ?? -1);
    setOpen(true);
  };

  // Focus follows the active item (roving focus): on open, and on every Arrow / Home / End.
  React.useEffect(() => {
    if (open && active >= 0) itemAt(active)?.focus();
  }, [open, active]);

  // A click outside the trigger and the menu closes it (focus stays where the click put it).
  React.useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  // Keep it on its trigger while the page scrolls or resizes.
  React.useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, { capture: true });
    };
  }, [open, measure]);

  const pick = (item: ActionMenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onClick();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledIndexes(items);
    const at = enabled.indexOf(indexOf(e.target));
    const move = (to: number | undefined) => { if (to !== undefined) setActive(to); };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': move(enabled[(at + 1) % enabled.length]); break;
      case 'ArrowUp': move(enabled[(at - 1 + enabled.length) % enabled.length]); break;
      case 'Home': move(enabled[0]); break;
      case 'End': move(enabled[enabled.length - 1]); break;
      case 'Escape': close(true); break;
      case 'Enter':
      case ' ': {
        const item = items[indexOf(e.target)];
        if (item) pick(item);
        break;
      }
      case 'Tab':
        // Back on the trigger, the browser's own Tab then moves on from there (not from the end of <body>).
        close(true);
        handled = false;
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    e.stopPropagation();
  };

  // Focus leaving the menu for anything but the trigger closes it.
  const onMenuBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && (menuRef.current?.contains(next) || triggerRef.current?.contains(next))) return;
    if (next) close(false);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(e.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  return (
    <div className={cn('relative inline-flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerTitle}
        onClick={() => (open ? close(false) : openAt('first'))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'inline-flex items-center justify-center rounded-lg', triggerSizeClassName,
          'border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]',
          'hover:bg-[var(--ff-bg-tertiary)] hover:text-[var(--ff-text-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
          'transition-colors',
          open && 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]',
        )}
      >
        {trigger ?? <MoreVertical className="h-4 w-4" />}
      </button>

      {open && place && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-orientation="vertical"
          aria-label={triggerLabel}
          onKeyDown={onMenuKeyDown}
          onBlur={onMenuBlur}
          data-side={place.p.top !== undefined ? 'down' : 'up'}
          style={{ position: 'fixed', top: place.p.top, bottom: place.p.bottom, right: place.right, maxHeight: place.p.maxHeight, minWidth: 180, zIndex: 9999 }}
          className="overflow-y-auto rounded-lg shadow-xl border py-1 bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)]"
        >
          {items.map((item, idx) => {
            const cls = cn(
              'w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors outline-none',
              'disabled:opacity-40 disabled:pointer-events-none',
              item.tone === 'destructive'
                ? idx === active
                  ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                  : 'text-red-700 dark:text-red-400 hover:bg-red-500/10'
                : idx === active
                ? 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]'
                : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] hover:text-[var(--ff-text-primary)]',
            );
            const content = <>{item.icon && <span className="flex-shrink-0 h-4 w-4 flex items-center">{item.icon}</span>}{item.label}</>;
            const common = {
              'data-menu-index': idx, role: 'menuitem', tabIndex: idx === active ? 0 : -1,
              onMouseEnter: () => { if (!item.disabled) setActive(idx); }, className: cls,
            };
            // A link item is a real <a>: a click navigates natively (closing the menu), Enter / Space go through pick().
            return item.href && !item.disabled
              ? <Link key={item.label} href={item.href} {...common} onClick={() => close(false)}>{content}</Link>
              : <button key={item.label} type="button" disabled={item.disabled} {...common} onClick={() => pick(item)}>{content}</button>;
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
