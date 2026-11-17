/**
 * ActionMenu — a keyboard-accessible menu button (WAI-ARIA menu button pattern) for overflow actions.
 *
 * Opening it (click, Enter, Space, ArrowDown; ArrowUp opens on the last item) moves focus INTO the menu, onto an item,
 * and the items rove: one has tabIndex 0, Arrow keys / Home / End move focus. With no enabled item the menu itself takes
 * focus, so Escape and Tab still work. Enter and Space act on the item that HAS focus when the key is pressed (read from
 * the event, never from a remembered index), so a key can never act on an item or a row the user has moved away from;
 * with focus on the menu itself (a click on its padding) the keys act from the ACTIVE item. Ctrl/Shift/Cmd+Enter on a
 * link item is the browser's (a new tab or window), and the menu then closes back to the trigger; on the menu itself it
 * only moves focus to the active item (the browser can open a link only from the link). Escape closes and returns focus
 * to the trigger (from the trigger too). On the trigger it is handled by a NATIVE listener on the button, so it stops at
 * the target: no bubbling listener above (a dialog's React onKeyDown, a native one on #root or document) sees it. A
 * listener in the CAPTURE phase above (useFocusTrap listens on document, capturing) still runs first: no listener on the
 * trigger can stop that. Tab closes and lets focus go on from the trigger; focus leaving the menu any other way, or a click outside it, closes it, and a click on the
 * menu's own padding keeps focus in it. The menu is fixed to the viewport: its side (down, or up when there is not room
 * below; panelPlacement) is chosen once when it opens, it is kept inside the viewport horizontally by its MEASURED width
 * (8px each side, capped at the viewport less 16px), and it follows its trigger on scroll. If the items change while it
 * is open, the focused item is found again by its label; a list that empties and refills starts again on its first item.
 * Keys the menu handles stop there (the menu is portalled, and React would bubble them to the trigger's ancestors,
 * e.g. a grid that has hotkeys of its own).
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/utils/cn';
import { chooseSide, placePanel, type PanelPlacement, type PanelSide } from './panelPlacement';
import {
  ITEM_PX, MENU_PAD_PX, MENU_MIN_W, MENU_MAX_W, arrowTarget, enabledIndexes, horizontal, useIsomorphicLayoutEffect,
} from './actionMenuParts';

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

type Place = { p: PanelPlacement; side: PanelSide; right?: number; left?: number };

export function ActionMenu({
  items, triggerLabel = 'More actions', className, trigger, triggerSizeClassName = 'h-9 w-9 max-lg:h-11 max-lg:w-11', triggerTitle,
}: ActionMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const [place, setPlace] = React.useState<Place | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  /** The menu's measured width (content-sized), so the horizontal clamp uses the real one. */
  const menuW = React.useRef(MENU_MIN_W);
  /** The label of the active item, so it can be found again when the items change while the menu is open. */
  const activeLabel = React.useRef<string | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  /** An item element by its index (data-menu-index): links and buttons alike, without relying on refs reaching an <a>. */
  const itemAt = (i: number) => menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${i}"]`) ?? null;
  const indexOf = (el: EventTarget | null) => Number((el as HTMLElement | null)?.closest?.('[data-menu-index]')?.getAttribute('data-menu-index') ?? -1);

  /** Placement on `side`; with no side (opening) the side is chosen from the room around the trigger. */
  const place_ = React.useCallback((side?: PanelSide) => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const s = side ?? chooseSide(r, window.innerHeight, items.length * ITEM_PX + MENU_PAD_PX);
    setPlace({ p: placePanel(r, window.innerHeight, s), side: s, ...horizontal(r, menuW.current) });
  }, [items.length]);

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openAt = (which: 'first' | 'last') => {
    const enabled = enabledIndexes(items);
    place_();
    setActive(which === 'first' ? enabled[0] ?? -1 : enabled[enabled.length - 1] ?? -1);
    setOpen(true);
  };

  // Remembered when the ACTIVE item changes (not when the items do: then it is the old list's label that is wanted).
  React.useEffect(() => {
    activeLabel.current = active >= 0 ? items[active]?.label ?? null : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The items changed while open (a menu that grows or shrinks): the active item is found again by its label, or the
  // first enabled one takes its place, so focus and the roving tabIndex point at the same item.
  // With no active item (the list was empty, or all disabled) the first enabled one is picked when one appears.
  React.useEffect(() => {
    if (!open) return;
    const at = activeLabel.current === null ? -1 : items.findIndex(it => it.label === activeLabel.current && !it.disabled);
    setActive(at >= 0 ? at : enabledIndexes(items)[0] ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Focus follows the active item (roving focus): on open, on every Arrow / Home / End, and when the items change.
  // No enabled item: the menu itself takes focus, so its keys (Escape, Tab) still work.
  React.useEffect(() => {
    if (!open) return;
    const el = active >= 0 ? itemAt(active) : menuRef.current;
    if (el && document.activeElement !== el) el.focus();
  }, [open, active, items]);

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

  // Keep it on its trigger while the page scrolls or resizes, on the side it opened on (it never flips under the pointer).
  const side = place?.side;
  React.useEffect(() => {
    if (!open || !side) return undefined;
    const follow = () => place_(side);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, { capture: true });
    };
  }, [open, side, place_]);

  // The menu's real width, measured before paint (on open and when the items change): re-placed if it differs.
  useIsomorphicLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const w = Math.max(MENU_MIN_W, menuRef.current.offsetWidth);
    if (w !== menuW.current) { menuW.current = w; place_(side); }
  }, [open, items, side, place_]);

  const pick = (item: ActionMenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onClick();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledIndexes(items);
    // From the menu itself (focus put there by a click on its padding) the keys act from the active item, if any.
    const onMenu = e.target === menuRef.current;
    const from = onMenu ? active : indexOf(e.target);
    const move = (to: number | undefined) => { if (to === undefined) return; if (to === active) itemAt(to)?.focus(); else setActive(to); };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp': move(arrowTarget(enabled, from, e.key)); break;
      case 'Home': move(enabled[0]); break;
      case 'End': move(enabled[enabled.length - 1]); break;
      case 'Escape': close(true); break;
      case 'Enter':
      case ' ': {
        const item = items[from];
        if (item?.href && e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
          // On the menu itself: focus goes to the link, and nothing runs (a pick would navigate in THIS tab).
          if (onMenu) { itemAt(from)?.focus(); break; }
          // On the link: the browser opens it in a new tab / window; the menu closes once it has, back to the trigger.
          handled = false;
          window.setTimeout(() => close(true), 0);
          break;
        }
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
  // Escape on the trigger while open is the menu's, and goes no further. React's stopPropagation acts only once the
  // event reaches React's root listener, after every native listener between here and there has run; a native listener
  // on the button stops it at the target. Closed, Escape is left alone (a dialog's).
  React.useEffect(() => {
    const t = triggerRef.current;
    if (!open || !t) return undefined;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    t.addEventListener('keydown', onEscape);
    return () => t.removeEventListener('keydown', onEscape);
  }, [open, close]);

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
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          onBlur={onMenuBlur}
          data-side={place.side}
          style={{ position: 'fixed', top: place.p.top, bottom: place.p.bottom, right: place.right, left: place.left, maxHeight: place.p.maxHeight, minWidth: MENU_MIN_W, maxWidth: MENU_MAX_W, zIndex: 9999 }}
          className="outline-none overflow-y-auto rounded-lg shadow-xl border py-1 bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)]"
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
