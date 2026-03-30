/**
 * Generic Sage-style horizontal navigation bar for module pages.
 * Tabs with dropdown menus; supports up to three-level flyout nesting.
 *
 * Usage:
 *   <ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />
 *
 * Accent classes are pre-written in full so Tailwind's purge pass retains them.
 */

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  isFlyout, isLinkActive,
  type Tab, type DropdownItem, type NavItem,
} from '../accounting/accountingNavConfig';

// 🟢 WORKING: Full class strings — never use template literals with Tailwind.
export type AccentColor = 'teal' | 'blue' | 'amber' | 'emerald' | 'violet' | 'slate' | 'rose' | 'cyan';

interface AccentTokens {
  activeBorder: string;
  activeText: string;
  activeLinkBg: string;
  activeSectionText: string;
}

export const ACCENT_CLASSES: Record<AccentColor, AccentTokens> = {
  teal: {
    activeBorder: 'border-teal-500',
    activeText: 'text-teal-400',
    activeLinkBg: 'text-teal-400 bg-teal-500/10',
    activeSectionText: 'text-teal-400',
  },
  blue: {
    activeBorder: 'border-blue-500',
    activeText: 'text-blue-400',
    activeLinkBg: 'text-blue-400 bg-blue-500/10',
    activeSectionText: 'text-blue-400',
  },
  amber: {
    activeBorder: 'border-amber-500',
    activeText: 'text-amber-400',
    activeLinkBg: 'text-amber-400 bg-amber-500/10',
    activeSectionText: 'text-amber-400',
  },
  emerald: {
    activeBorder: 'border-emerald-500',
    activeText: 'text-emerald-400',
    activeLinkBg: 'text-emerald-400 bg-emerald-500/10',
    activeSectionText: 'text-emerald-400',
  },
  violet: {
    activeBorder: 'border-violet-500',
    activeText: 'text-violet-400',
    activeLinkBg: 'text-violet-400 bg-violet-500/10',
    activeSectionText: 'text-violet-400',
  },
  slate: {
    activeBorder: 'border-slate-500',
    activeText: 'text-slate-400',
    activeLinkBg: 'text-slate-400 bg-slate-500/10',
    activeSectionText: 'text-slate-400',
  },
  rose: {
    activeBorder: 'border-rose-500',
    activeText: 'text-rose-400',
    activeLinkBg: 'text-rose-400 bg-rose-500/10',
    activeSectionText: 'text-rose-400',
  },
  cyan: {
    activeBorder: 'border-cyan-500',
    activeText: 'text-cyan-400',
    activeLinkBg: 'text-cyan-400 bg-cyan-500/10',
    activeSectionText: 'text-cyan-400',
  },
};

export interface ModuleNavProps {
  tabs?: Tab[];
  getActiveTabId: (pathname: string, query: Record<string, string | string[] | undefined>) => string;
  accentColor: AccentColor;
}

// ─── Shared static classes ────────────────────────────────────────────────────

const panelCls =
  'absolute left-full top-0 bg-gray-800 border border-gray-700 rounded-r-lg shadow-xl min-w-[210px] py-1';

const inactiveLinkCls =
  'text-gray-300 hover:text-white hover:bg-gray-700/50';

// ─── Internal helpers that need accent tokens ─────────────────────────────────

function makeLinkCls(active: boolean, accent: AccentTokens): string {
  return `block px-4 py-2 text-sm whitespace-nowrap transition-colors ${
    active ? accent.activeLinkBg : inactiveLinkCls
  }`;
}

function makeSectionCls(hovered: boolean, active: boolean, accent: AccentTokens): string {
  return `flex items-center justify-between px-4 py-2.5 text-sm cursor-default transition-colors ${
    hovered
      ? 'bg-gray-700 text-white'
      : active
        ? accent.activeSectionText
        : 'text-gray-300'
  }`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SubMenuItemsProps {
  items: NavItem[];
  asPath: string;
  onClose: () => void;
  accent: AccentTokens;
}

function SubMenuItems({ items, asPath, onClose, accent }: SubMenuItemsProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timerRef.current) clearTimeout(timerRef.current); };
  const delayed = () => { timerRef.current = setTimeout(() => setHovered(null), 150); };
  useEffect(() => () => clear(), []);

  return (
    <>
      {items.map(item => {
        if (!isFlyout(item)) {
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={makeLinkCls(isLinkActive(item.href, asPath), accent)}
            >
              {item.label}
            </Link>
          );
        }
        const isHov = hovered === item.section;
        return (
          <div
            key={item.section}
            className="relative"
            onMouseEnter={() => { clear(); setHovered(item.section); }}
            onMouseLeave={delayed}
          >
            <div className={makeSectionCls(isHov, false, accent)}>
              <span className="font-medium">{item.section}</span>
              <ChevronRight className="h-3.5 w-3.5 ml-6 flex-shrink-0" />
            </div>
            {isHov && (
              <div onMouseEnter={clear} onMouseLeave={delayed} className={panelCls}>
                <SubMenuItems items={item.items} asPath={asPath} onClose={onClose} accent={accent} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

interface FlatDropdownProps {
  items: DropdownItem[];
  asPath: string;
  onClose: () => void;
  accent: AccentTokens;
}

function FlatDropdown({ items, asPath, onClose, accent }: FlatDropdownProps) {
  return (
    <div className="absolute top-full left-0 bg-gray-800 border border-gray-700 rounded-b-lg shadow-xl min-w-[220px] py-1 z-40">
      {items.map(item => (
        <Link
          key={item.href}
          href={item.href}
          onClick={onClose}
          className={makeLinkCls(isLinkActive(item.href, asPath), accent)}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

interface FlyoutDropdownProps {
  tab: Tab;
  asPath: string;
  onClose: () => void;
  accent: AccentTokens;
}

function FlyoutDropdown({ tab, asPath, onClose, accent }: FlyoutDropdownProps) {
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  const delayedClose = () => { timeoutRef.current = setTimeout(() => setHoveredSection(null), 150); };
  useEffect(() => () => clearTimer(), []);

  const sections = (tab.items ?? []).filter(isFlyout);

  return (
    <div className="absolute top-full left-0 z-40">
      <div className="bg-gray-800 border border-gray-700 rounded-b-lg shadow-xl min-w-[200px] py-1">
        {tab.topItems?.map(item => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className="block px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-700/50 transition-colors"
          >
            {item.label}
          </Link>
        ))}
        {tab.topItems && tab.topItems.length > 0 && (
          <div className="border-t border-gray-700 my-1" />
        )}

        {sections.map(section => {
          const isHovered = hoveredSection === section.section;
          return (
            <div
              key={section.section}
              className="relative"
              onMouseEnter={() => { clearTimer(); setHoveredSection(section.section); }}
              onMouseLeave={delayedClose}
            >
              <div className={makeSectionCls(isHovered, false, accent)}>
                <span className="font-medium">{section.section}</span>
                <ChevronRight className="h-3.5 w-3.5 ml-6 flex-shrink-0" />
              </div>
              {isHovered && (
                <div onMouseEnter={clearTimer} onMouseLeave={delayedClose} className={panelCls}>
                  <SubMenuItems items={section.items} asPath={asPath} onClose={onClose} accent={accent} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

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
  const navRef = useRef<HTMLDivElement>(null);
  const activeTab = typeof getActiveTabId === 'function'
    ? getActiveTabId(router.pathname, router.query)
    : 'dashboard';
  const accent = ACCENT_CLASSES[accentColor];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenTab(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => { setOpenTab(null); }, [router.pathname]);

  const hasFlyout = (t: Tab) => t.items?.some(isFlyout) ?? false;

  return (
    <nav ref={navRef} className="bg-gray-900 border-b border-gray-700 relative z-30">
      <div className="flex items-center gap-0 px-2">
        {(tabs ?? []).map(t => (
          <div key={t.id} className="relative" data-tour={`nav-${t.id}`}>
            {t.href ? (
              <Link
                href={t.href}
                className={`block px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === t.id
                    ? `${accent.activeBorder} ${accent.activeText}`
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
              </Link>
            ) : (
              <button
                onClick={() => setOpenTab(openTab === t.id ? null : t.id)}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors inline-flex items-center gap-1 ${
                  activeTab === t.id
                    ? `${accent.activeBorder} ${accent.activeText}`
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
                <ChevronDown className={`h-3 w-3 transition-transform ${openTab === t.id ? 'rotate-180' : ''}`} />
              </button>
            )}

            {t.items && openTab === t.id && (
              hasFlyout(t)
                ? <FlyoutDropdown tab={t} asPath={router.asPath} onClose={() => setOpenTab(null)} accent={accent} />
                : <FlatDropdown items={t.items as DropdownItem[]} asPath={router.asPath} onClose={() => setOpenTab(null)} accent={accent} />
            )}
          </div>
        ))}
      </div>
    </nav>
  );
}
