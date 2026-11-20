/**
 * SettingsMenu — Cog icon in the app header that opens a flyout listing every
 * setting / admin / data-management / group-consolidation page. Powered by the
 * settingsTab nav config so the cog and the rest of the nav share one source
 * of truth. Above the pages, a Display group holds the theme and row-density
 * toggles (set-once controls, so not in the header bar; on top, so a short
 * screen shows them without scrolling the popover).
 *
 * Roles: the popover is a group named "Settings" holding the Display group (its
 * aria-pressed toggles) and, beside it, the menu of pages, which owns only
 * menuitems (in one group per section). The cog is a disclosure button
 * (aria-expanded + aria-controls): the popup is not itself a menu.
 */

import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/router';
import { Settings as SettingsIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { TableDensityToggle } from '@/components/ui/TableDensityToggle';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { cn } from '@/utils/cn';
import { anchoredMenuStyle } from '@/components/layout/menuPosition';
import { settingsTab } from '@/components/accounting/accountingNavConfig';
import { isFlyout } from '@/components/accounting/navSections/types';
import type { DropdownItem } from '@/components/accounting/navSections/types';
import { getActiveModuleId, activeHrefAmong } from '@/components/accounting/navSections/activeTab';

interface PanelProps {
  anchorRect: DOMRect;
  onSelect: (href: string) => void;
  panelRef: React.RefObject<HTMLDivElement>;
  /** The current page: its entry is marked as the current one. */
  asPath: string;
  /** Opened from the keyboard: focus moves to the first entry (the panel is portalled, out of the header's tab order). */
  focusFirst: boolean;
  /** Breakpoint classes of the Display group: shown only where MobileHeaderMenu does not carry the toggles. */
  displayClassName: string;
  id: string;
}

function Panel({ anchorRect, onSelect, panelRef, asPath, focusFirst, displayClassName, id }: PanelProps) {
  const sections = (settingsTab.items ?? []).filter(isFlyout);
  const current = activeHrefAmong(sections.flatMap((s) => s.items), asPath);
  const titleId = useId();
  const displayId = useId();
  const displayRef = useRef<HTMLDivElement>(null);

  // Keyboard open: focus the first control in reading order, so Tab runs top to bottom (toggles, then pages). Where the
  // Display group is hidden (below its breakpoint) that is the first page.
  useEffect(() => {
    if (!focusFirst) return;
    const display = displayRef.current;
    const shown = display && getComputedStyle(display).display !== 'none';
    const first = shown ? display.querySelector<HTMLElement>('button') : panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [focusFirst, panelRef]);

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role="group"
      aria-labelledby={titleId}
      style={anchoredMenuStyle(anchorRect, 640)}
      className={cn(
        'z-[9999] py-3 px-3 rounded-xl',
        'bg-white dark:bg-gray-900',
        'border border-gray-200 dark:border-gray-700',
        'shadow-xl shadow-black/10 dark:shadow-black/40',
      )}
    >
      <p id={titleId} className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 select-none">
        Settings
      </p>
      <div ref={displayRef} role="group" aria-labelledby={displayId} className={cn(displayClassName, 'mb-3 pb-3 px-2 border-b border-gray-200 dark:border-gray-700')}>
        <p id={displayId} className="mb-2 text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
          Display
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-700 dark:text-gray-200">
          <div className="flex items-center gap-2"><span>Theme</span><ThemeToggle /></div>
          <div className="flex items-center gap-2"><span>Row density</span><TableDensityToggle /></div>
        </div>
      </div>
      <div role="menu" aria-labelledby={titleId} className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        {sections.map(section => (
          <div key={section.section} role="group" aria-labelledby={`${titleId}-${section.section.replace(/\W+/g, '-')}`}>
            <p id={`${titleId}-${section.section.replace(/\W+/g, '-')}`} className="px-2 mb-1 text-xs font-semibold uppercase tracking-wider text-teal-600 dark:text-teal-400">
              {section.section}
            </p>
            <ul role="none">
              {(section.items as DropdownItem[]).map(item => (
                <li key={item.href} role="none">
                  <button
                    role="menuitem"
                    aria-current={item.href === current ? 'page' : undefined}
                    onClick={() => onSelect(item.href)}
                    className={cn(
                      'w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-teal-50 dark:hover:bg-teal-900/20 hover:text-teal-700 dark:hover:text-teal-300 transition-colors',
                      item.href === current ? 'font-medium text-teal-700 dark:text-teal-300' : 'text-gray-700 dark:text-gray-200',
                    )}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

interface SettingsMenuProps {
  /** Breakpoint classes of the popover's Display group (theme, row density): from where MobileHeaderMenu hides. */
  displayClassName: string;
}

export function SettingsMenu({ displayClassName }: SettingsMenuProps) {
  const router = useRouter();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [focusFirst, setFocusFirst] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // A settings page has no top tab, so the cog itself shows where the user is.
  const active = getActiveModuleId(router.pathname, router.query as Record<string, string | string[] | undefined>) === 'settings';

  const openMenu = useCallback((keyboard: boolean) => {
    if (buttonRef.current) {
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    }
    setFocusFirst(keyboard);
    setOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const navigate = useCallback((href: string) => {
    setOpen(false);
    void router.push(href);
  }, [router]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeMenu]);

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

  return (
    <>
      <Tooltip content="Settings" position="bottom">
        <button
          ref={buttonRef}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label="Settings"
          aria-current={active ? 'true' : undefined}
          onClick={e => open ? closeMenu() : openMenu(e.detail === 0)}
          className={cn(
            'p-2 rounded-lg transition-colors',
            open || active
              ? 'bg-teal-500/[0.08] text-teal-700 dark:text-teal-300'
              : 'text-ink-muted hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5',
          )}
        >
          <SettingsIcon className="w-4 h-4" />
        </button>
      </Tooltip>

      {open && anchorRect && <Panel anchorRect={anchorRect} onSelect={navigate} panelRef={panelRef} asPath={router.asPath} focusFirst={focusFirst}
        displayClassName={displayClassName} id={panelId} />}
    </>
  );
}
