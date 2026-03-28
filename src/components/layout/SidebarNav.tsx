/**
 * Sidebar navigation using the same TABS config as the top-bar.
 * Hover a tab → flyout panel pops to the right via a portal on document.body.
 * Sub-sections cascade further right, also via portals so nothing is clipped.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  TABS,
  getActiveTabId,
  isFlyout,
  isLinkActive,
  type Tab,
  type NavItem,
} from '../accounting/accountingNavConfig';

// ─── Shared styles ──────────────────────────────────────────────────────────

const panelCls = 'bg-gray-800 border border-gray-700 rounded-lg shadow-2xl min-w-[210px] py-1';

const linkCls = (active: boolean) =>
  `block px-4 py-1.5 text-sm whitespace-nowrap transition-colors ${
    active ? 'text-teal-400 bg-teal-500/10 font-medium' : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
  }`;

// ─── Recursive section flyout using portals ─────────────────────────────────

function SectionFlyout({
  label,
  items,
  asPath,
  onNav,
  parentRight,
  parentTop,
}: {
  label: string;
  items: NavItem[];
  asPath: string;
  onNav: () => void;
  parentRight: number;
  parentTop: number;
}) {
  const [open, setOpen] = useState(false);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cl = () => { if (timer.current) clearTimeout(timer.current); };
  const dl = () => { timer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => cl(), []);

  const handleEnter = () => {
    cl();
    setOpen(true);
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setSubPos({ top: rect.top, left: rect.right });
    }
  };

  return (
    <div ref={ref} onMouseEnter={handleEnter} onMouseLeave={dl}>
      <div className={`flex items-center justify-between px-4 py-2 text-sm cursor-default transition-colors ${
        open ? 'bg-gray-700 text-white' : 'text-gray-300 hover:text-gray-600'
      }`}>
        <span className="font-medium">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 ml-4 flex-shrink-0" />
      </div>

      {open && subPos && createPortal(
        <div
          style={{ position: 'fixed', top: subPos.top, left: subPos.left, zIndex: 99999 }}
          className={panelCls}
          onMouseEnter={cl}
          onMouseLeave={dl}
        >
          {items.map(item => {
            if (!isFlyout(item)) {
              return (
                <Link key={item.href} href={item.href} onClick={onNav} className={linkCls(isLinkActive(item.href, asPath))}>
                  {item.label}
                </Link>
              );
            }
            // Nested section → recurse
            return (
              <SectionFlyout
                key={item.section}
                label={item.section}
                items={item.items}
                asPath={asPath}
                onNav={onNav}
                parentRight={subPos.left + 210}
                parentTop={subPos.top}
              />
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Tab flyout content ─────────────────────────────────────────────────────

function TabFlyoutContent({ tab, asPath, onNav }: { tab: Tab; asPath: string; onNav: () => void }) {
  const hasSections = tab.items?.some(isFlyout) ?? false;

  return (
    <>
      {/* Quick actions */}
      {tab.topItems?.map(item => (
        <Link key={item.href} href={item.href} onClick={onNav}
          className="block px-4 py-2 text-sm text-teal-400 hover:bg-gray-700/50 transition-colors whitespace-nowrap">
          + {item.label}
        </Link>
      ))}
      {tab.topItems && tab.topItems.length > 0 && <div className="border-t border-gray-700 my-1" />}

      {/* Sections with sub-flyouts */}
      {hasSections && tab.items?.map(item => {
        if (!isFlyout(item)) {
          return <Link key={item.href} href={item.href} onClick={onNav} className={linkCls(isLinkActive(item.href, asPath))}>{item.label}</Link>;
        }
        return (
          <SectionFlyout
            key={item.section}
            label={item.section}
            items={item.items}
            asPath={asPath}
            onNav={onNav}
            parentRight={0}
            parentTop={0}
          />
        );
      })}

      {/* Flat items */}
      {!hasSections && tab.items?.map(item => {
        if (isFlyout(item)) return null;
        return <Link key={item.href} href={item.href} onClick={onNav} className={linkCls(isLinkActive(item.href, asPath))}>{item.label}</Link>;
      })}
    </>
  );
}

// ─── Main sidebar nav ───────────────────────────────────────────────────────

interface SidebarNavProps {
  collapsed?: boolean;
}

export function SidebarNav({ collapsed }: SidebarNavProps) {
  const router = useRouter();
  const asPath = router.asPath;
  const activeTabId = getActiveTabId(router.pathname, router.query);

  const [flyout, setFlyout] = useState<{ tabId: string; top: number; left: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cl = useCallback(() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
  const dl = useCallback(() => { timer.current = setTimeout(() => setFlyout(null), 180); }, []);

  useEffect(() => { setFlyout(null); }, [router.pathname]);
  useEffect(() => () => cl(), [cl]);

  const openFlyout = useCallback((tabId: string, el: HTMLElement) => {
    cl();
    const rect = el.getBoundingClientRect();
    setFlyout({ tabId, top: rect.top, left: rect.right });
  }, [cl]);

  const flyoutTab = flyout ? TABS.find(t => t.id === flyout.tabId) : null;

  return (
    <>
      <nav className="flex-1 overflow-y-auto py-2">
        {TABS.map(tab => {
          const active = activeTabId === tab.id;
          const hasItems = !!(tab.items?.length);
          const isOpen = flyout?.tabId === tab.id;

          if (tab.href && !hasItems) {
            return (
              <Link key={tab.id} href={tab.href}
                className={`flex items-center px-4 py-2 text-sm font-medium transition-colors border-l-2 ${
                  active ? 'text-teal-600 dark:text-teal-400 bg-teal-500/10 border-teal-500'
                    : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 border-transparent'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? tab.label : undefined}>
                {collapsed ? tab.label.slice(0, 2) : tab.label}
              </Link>
            );
          }

          return (
            <div key={tab.id}
              onMouseEnter={(e) => openFlyout(tab.id, e.currentTarget)}
              onMouseLeave={dl}
              className={`flex items-center justify-between px-4 py-2 text-sm font-medium cursor-pointer transition-colors border-l-2 ${
                active || isOpen ? 'text-teal-600 dark:text-teal-400 bg-teal-500/10 border-teal-500'
                  : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 border-transparent'
              } ${collapsed ? 'justify-center px-0' : ''}`}
              title={collapsed ? tab.label : undefined}>
              <span>{collapsed ? tab.label.slice(0, 2) : tab.label}</span>
              {!collapsed && <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 ${isOpen ? 'text-teal-400' : 'text-gray-500'}`} />}
            </div>
          );
        })}
      </nav>

      {/* First-level flyout via portal */}
      {flyoutTab && flyout && createPortal(
        <div
          style={{ position: 'fixed', top: flyout.top, left: flyout.left, zIndex: 99999 }}
          className={panelCls}
          onMouseEnter={cl}
          onMouseLeave={dl}
        >
          <TabFlyoutContent tab={flyoutTab} asPath={asPath} onNav={() => setFlyout(null)} />
        </div>,
        document.body
      )}
    </>
  );
}
