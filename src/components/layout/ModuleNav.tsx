/**
 * Generic Sage-style horizontal navigation bar for module pages.
 * Every tab with a menu opens it on hover; up to three-level flyout nesting.
 *
 * Usage:
 *   <ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />
 *
 * A tab with `href` and a menu is a split control: the label links to the
 * landing page, a chevron button beside it opens the menu (Enter/Space), and
 * ArrowDown on the label opens it too. A tab with a menu and no `href` is one
 * button. On touch the first tap on a split label opens the menu instead of
 * navigating.
 *
 * Accent classes are pre-written in full so Tailwind's purge pass retains them.
 */

import { useState, useRef, useEffect } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { isFlyout, type Tab, type DropdownItem } from '../accounting/accountingNavConfig';
import { ACCENT_CLASSES, type AccentColor } from './moduleNavAccent';
import { FlyoutDropdown, FlatDropdown, panelItems } from './ModuleNavMenus';

export { ACCENT_CLASSES };
export type { AccentColor };

export interface ModuleNavProps {
  tabs?: Tab[];
  getActiveTabId: (pathname: string, query: Record<string, string | string[] | undefined>) => string;
  accentColor: AccentColor;
}

const hasMenu = (t: Tab) => (t.items?.length ?? 0) > 0;
const hasFlyout = (t: Tab) => t.items?.some(isFlyout) ?? false;

/** Menus open on hover for a real mouse only; touch and pen open on tap. */
const isHoverPointer = (e: { pointerType: string }) => e.pointerType === 'mouse';

/**
 * Generic Sage-style module nav bar.
 *
 * @param tabs            Array of top-level tabs (with optional nested items)
 * @param getActiveTabId  Route-to-tab resolver for the owning module
 * @param accentColor     Tailwind color token used for active-state highlights
 */
export function ModuleNav({ tabs, getActiveTabId, accentColor }: ModuleNavProps) {
  const router = useRouter();
  const [openTab, setOpenTab] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const lastPointer = useRef<string>('');
  const focusOnOpen = useRef(false);
  const activeTab = typeof getActiveTabId === 'function'
    ? getActiveTabId(router.pathname, router.query)
    : 'dashboard';
  const accent = ACCENT_CLASSES[accentColor];

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHover = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  const delayedClose = () => { clearHover(); hoverTimer.current = setTimeout(() => setOpenTab(null), 150); };
  useEffect(() => clearHover, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenTab(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { setOpenTab(null); }, [router.asPath]);

  // A menu opened from the keyboard moves focus to its first entry.
  useEffect(() => {
    if (!openTab || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const panel = navRef.current?.querySelector<HTMLElement>(`[data-tour="nav-${openTab}"] [data-nav-panel]`);
    if (panel) panelItems(panel)[0]?.focus();
  }, [openTab]);

  const open = (id: string, keyboard = false) => {
    clearHover();
    focusOnOpen.current = keyboard;
    setOpenTab(id);
  };

  const closeToTrigger = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || openTab === null) return;
    const trigger = e.currentTarget.querySelector<HTMLElement>('[data-nav-trigger]');
    const panel = e.currentTarget.querySelector<HTMLElement>('[data-nav-panel]');
    const focusInPanel = !!panel && panel.contains(document.activeElement);
    setOpenTab(null);
    if (focusInPanel) trigger?.focus();
  };

  const textCls = (t: Tab) =>
    `text-sm font-medium whitespace-nowrap transition-colors ${
      activeTab === t.id ? accent.activeText : 'text-ink-muted hover:text-ink'
    }`;
  const borderCls = (t: Tab) => `border-b-2 ${activeTab === t.id ? accent.activeBorder : 'border-transparent'}`;

  const dropdown = (t: Tab, id: string) => {
    const props = { asPath: router.asPath, onClose: () => setOpenTab(null), accent, id };
    return hasFlyout(t)
      ? <FlyoutDropdown tab={t} {...props} />
      : <FlatDropdown items={t.items as DropdownItem[]} {...props} />;
  };

  return (
    <nav ref={navRef} className="bg-white dark:bg-gray-900 border-b border-gray-300 dark:border-gray-700 relative z-30">
      <div className="flex items-center gap-0 px-2">
        {(tabs ?? []).map(t => {
          const menu = hasMenu(t);
          const isOpen = menu && openTab === t.id;
          const panelId = `nav-menu-${t.id}`;
          const trigger = {
            'data-nav-trigger': '',
            'aria-haspopup': 'true' as const,
            'aria-expanded': isOpen,
            'aria-controls': isOpen ? panelId : undefined,
          };
          return (
            <div
              key={t.id}
              className="relative"
              data-tour={`nav-${t.id}`}
              onPointerDown={e => { lastPointer.current = e.pointerType; }}
              onPointerEnter={menu ? e => { if (isHoverPointer(e)) open(t.id); } : undefined}
              onPointerLeave={menu ? e => { if (isHoverPointer(e)) delayedClose(); } : undefined}
              onKeyDownCapture={() => { lastPointer.current = ''; }}
              onKeyDown={menu ? closeToTrigger : undefined}
            >
              {t.href && !menu && (
                <Link href={t.href} aria-current={activeTab === t.id ? 'true' : undefined} className={`block px-4 py-2.5 ${borderCls(t)} ${textCls(t)}`}>{t.label}</Link>
              )}
              {t.href && menu && (
                <div className={`flex items-center ${borderCls(t)}`}>
                  <Link
                    href={t.href}
                    aria-current={activeTab === t.id ? 'true' : undefined}
                    className={`py-2.5 pl-4 pr-1 ${textCls(t)}`}
                    onClick={e => {
                      // Touch and pen: the first tap opens the menu, the second follows the link.
                      if (!isOpen && lastPointer.current !== 'mouse' && lastPointer.current !== '') {
                        e.preventDefault();
                        open(t.id);
                      }
                    }}
                    onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); open(t.id, true); } }}
                  >
                    {t.label}
                  </Link>
                  <button
                    type="button"
                    {...trigger}
                    aria-label={`${t.label} menu`}
                    className={`py-2.5 pl-0.5 pr-3 ${textCls(t)}`}
                    onClick={e => (isOpen ? setOpenTab(null) : open(t.id, e.detail === 0))}
                  >
                    <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </button>
                </div>
              )}
              {!t.href && menu && (
                <button
                  type="button"
                  {...trigger}
                  aria-current={activeTab === t.id ? 'true' : undefined}
                  className={`px-4 py-2.5 inline-flex items-center gap-1 ${borderCls(t)} ${textCls(t)}`}
                  onClick={e => (isOpen ? setOpenTab(null) : open(t.id, e.detail === 0))}
                  onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); open(t.id, true); } }}
                >
                  {t.label}
                  <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
              )}
              {isOpen && dropdown(t, panelId)}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
