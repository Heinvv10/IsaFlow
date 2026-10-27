/**
 * Sidebar navigation using the same TABS config as the top-bar.
 * Hover a tab → flyout panel pops to the right via a portal on document.body.
 * Sub-sections cascade further right, also via portals so nothing is clipped (SidebarFlyouts.tsx).
 *
 * Keyboard: every tab row is focusable. ArrowRight (or Enter/Space on a row without its own page) opens the row's
 * flyout and focuses its first entry; Escape closes it and returns focus to the row.
 */

import { useState, useRef, useEffect, useCallback, type KeyboardEvent as ReactKeyboardEvent, type FocusEvent as ReactFocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { TABS, getActiveTabId } from '../accounting/accountingNavConfig';
import { panelCls, panelEntries, moveInPanel, TabFlyoutContent } from './SidebarFlyouts';
import { stripVatNav } from '../accounting/navSections/vatNav';
import { useVatRegistration } from '@/hooks/useVatRegistration';

// ─── Main sidebar nav ───────────────────────────────────────────────────────

interface SidebarNavProps {
  collapsed?: boolean;
}

export function SidebarNav({ collapsed }: SidebarNavProps) {
  const router = useRouter();
  const asPath = router.asPath;
  const activeTabId = getActiveTabId(router.pathname, router.query);

  const { isRegistered } = useVatRegistration();
  const [flyout, setFlyout] = useState<{ tabId: string; top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Touch and pen have no hover: the first tap on a label that has a flyout opens it, the second follows the link.
  // `wasOpen` is read at pointerdown, before the compatibility mouseenter that follows a tap opens the flyout itself.
  const tap = useRef({ type: '', wasOpen: false });

  const cl = useCallback(() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
  const dl = useCallback(() => { timer.current = setTimeout(() => setFlyout(null), 180); }, []);

  useEffect(() => { setFlyout(null); }, [router.pathname]);
  useEffect(() => () => cl(), [cl]);
  // Escape closes an open flyout (and its sub-flyouts, which unmount with it) and puts focus back on its row.
  const trigger = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  useEffect(() => {
    if (!flyout) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setFlyout(null);
      if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flyout]);
  useEffect(() => {
    if (!flyout || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    panelEntries(panel.current)[0]?.focus();
  }, [flyout]);

  const openFlyout = useCallback((tabId: string, el: HTMLElement) => {
    cl();
    trigger.current = el;
    const rect = el.getBoundingClientRect();
    setFlyout({ tabId, top: rect.top, left: rect.right });
  }, [cl]);

  /** Focus leaving the flyouts (Tab past the last entry) closes them; moving into a section's sub-panel does not. */
  const closeOnFocusOut = (e: ReactFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as HTMLElement | null;
    if (next && (next.closest('[data-sidebar-flyout]') || next === trigger.current)) return;
    setFlyout(null);
  };

  /** ArrowRight opens the flyout from the keyboard; so do Enter and Space on a row that has no page of its own. */
  const keyOpen = (tabId: string, ownPage: boolean) => (e: ReactKeyboardEvent<HTMLElement>) => {
    tap.current = { type: '', wasOpen: false };
    if (e.key !== 'ArrowRight' && (ownPage || (e.key !== 'Enter' && e.key !== ' '))) return;
    e.preventDefault();
    focusOnOpen.current = true;
    openFlyout(tabId, e.currentTarget);
  };

  const tabs = stripVatNav(TABS, isRegistered);
  const flyoutTab = flyout ? tabs.find(t => t.id === flyout.tabId) : null;

  return (
    <>
      <nav className="flex-1 overflow-y-auto py-2">
        {tabs.map(tab => {
          const active = activeTabId === tab.id;
          const hasItems = !!(tab.items?.length);
          const isOpen = flyout?.tabId === tab.id;

          if (tab.href && !hasItems) {
            return (
              <Link key={tab.id} href={tab.href}
                data-testid={`sidebar-tab-${tab.id}`}
                className={`flex items-center px-4 py-2 text-sm font-medium transition-colors border-l-[3px] ${
                  active
                    ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? tab.label : undefined}>
                {collapsed ? tab.label.slice(0, 2) : tab.label}
              </Link>
            );
          }

          if (tab.href && hasItems) {
            return (
              <Link key={tab.id} href={tab.href}
                data-testid={`sidebar-tab-${tab.id}`}
                onMouseEnter={(e) => openFlyout(tab.id, e.currentTarget)}
                onMouseLeave={dl}
                onPointerDown={(e) => { tap.current = { type: e.pointerType, wasOpen: isOpen }; }}
                onKeyDown={keyOpen(tab.id, true)}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={(e) => {
                  const { type, wasOpen } = tap.current;
                  tap.current = { type: '', wasOpen: false };
                  if (type === '' || type === 'mouse' || wasOpen) return;
                  e.preventDefault();
                  openFlyout(tab.id, e.currentTarget);
                }}
                className={`flex items-center justify-between px-4 py-2 text-sm font-medium transition-colors border-l-[3px] ${
                  active || isOpen
                    ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? tab.label : undefined}>
                <span>{collapsed ? tab.label.slice(0, 2) : tab.label}</span>
                {!collapsed && <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 ${isOpen ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 dark:text-slate-500'}`} />}
              </Link>
            );
          }

          return (
            <div key={tab.id}
              data-testid={`sidebar-tab-${tab.id}`}
              role="button"
              tabIndex={0}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onKeyDown={keyOpen(tab.id, false)}
              onMouseEnter={(e) => openFlyout(tab.id, e.currentTarget)}
              onMouseLeave={dl}
              className={`flex items-center justify-between px-4 py-2 text-sm font-medium cursor-pointer transition-colors border-l-[3px] ${
                active || isOpen
                  ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
              } ${collapsed ? 'justify-center px-0' : ''}`}
              title={collapsed ? tab.label : undefined}>
              <span>{collapsed ? tab.label.slice(0, 2) : tab.label}</span>
              {!collapsed && <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 ${isOpen ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 dark:text-slate-500'}`} />}
            </div>
          );
        })}
      </nav>

      {/* First-level flyout via portal */}
      {flyoutTab && flyout && createPortal(
        <div
          ref={panel}
          style={{ position: 'fixed', top: flyout.top, left: flyout.left, zIndex: 99999 }}
          className={panelCls}
          onMouseEnter={cl}
          onMouseLeave={dl}
          onKeyDown={moveInPanel}
          onBlur={closeOnFocusOut}
          data-sidebar-flyout=""
        >
          <TabFlyoutContent tab={flyoutTab} asPath={asPath} onNav={() => setFlyout(null)} />
        </div>,
        document.body
      )}
    </>
  );
}
