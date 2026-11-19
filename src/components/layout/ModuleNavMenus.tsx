/**
 * Dropdown panels for ModuleNav: the flat list, the sectioned flyout, and the
 * nested sub-panels.
 *
 * Mouse: a section row opens its sub-panel on hover (150 ms close delay), with hover intent (useFlyoutSection).
 * Every panel is placed inside the viewport (useFlyoutPlacement) and focus never scrolls the shell (focusInPanel).
 * Keyboard: Enter, Space or ArrowRight opens a row and focuses its first item;
 * ArrowUp/Down/Home/End move within a panel; Escape or ArrowLeft closes the
 * sub-panel and returns focus to its row.
 */

import { useRef, useEffect, useLayoutEffect, useId } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import Link from 'next/link';
import { ChevronRight, Settings } from 'lucide-react';
import { NavLinksBlock } from './NavLinksBlock';
import {
  isFlyout, activeHrefAmong,
  type Tab, type DropdownItem, type NavItem,
} from '../accounting/accountingNavConfig';
import type { AccentTokens } from './moduleNavAccent';
import type { FlyoutDir } from './menuPosition';
import { useOpenSection, type OpenSection } from './useFlyoutSection';
import { useFlyoutPlacement, focusInPanel } from './useFlyoutPlacement';

// w-min: the width the panel had as an absolute child of its row, wherever it is placed now.
const panelCls = (dir: FlyoutDir) =>
  `bg-surface-raised border border-line ${dir === 'left' ? 'rounded-l-lg' : 'rounded-r-lg'} shadow-xl min-w-[210px] w-min py-1`;

const inactiveLinkCls =
  'text-ink-muted hover:text-ink hover:bg-surface-sunken';

const settingLinkCls = (active: boolean, accent: AccentTokens) =>
  active ? accent.activeLinkBg : 'text-ink-muted hover:text-ink hover:bg-surface-sunken';

export function makeLinkCls(active: boolean, accent: AccentTokens): string {
  return `block px-4 py-2 text-sm whitespace-nowrap transition-colors ${
    active ? accent.activeLinkBg : inactiveLinkCls
  }`;
}

const sectionCls = (hovered: boolean) =>
  `flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors ${
    hovered ? 'bg-surface-sunken text-ink' : 'text-ink-muted hover:bg-surface-sunken'
  }`;

// ─── Keyboard helpers ─────────────────────────────────────────────────────────

/** Focusable entries owned by `panel` itself, not by a sub-panel nested inside it. */
export function panelItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>('a[href], button[data-nav-row]'))
    .filter(el => el.closest('[data-nav-panel]') === panel);
}

/** ArrowUp/Down/Home/End over the entries of the panel the handler is attached to. */
export function panelArrowKeys(e: ReactKeyboardEvent<HTMLElement>): void {
  const move = ({ ArrowDown: 1, ArrowUp: -1, Home: 0, End: 0 } as Record<string, number>)[e.key];
  if (move === undefined) return;
  const items = panelItems(e.currentTarget);
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else next = at === -1 ? (move > 0 ? 0 : items.length - 1) : (at + move + items.length) % items.length;
  e.preventDefault();
  e.stopPropagation();
  focusInPanel(items[next]);
}

interface SectionGroupProps {
  section: string;
  items: NavItem[];
  asPath: string;
  onClose: () => void;
  accent: AccentTokens;
  state: OpenSection;
  /** The way the panel holding this row opened: the sub-panel tries the same way first. */
  dir: FlyoutDir;
  /** Where the panel holding this row is: the sub-panel is re-placed when it moves. */
  parentAt: string;
}

function SectionGroup({ section, items, asPath, onClose, accent, state, dir, parentAt }: SectionGroupProps) {
  const isOpen = state.open === section;
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const place = useFlyoutPlacement(isOpen, () => wrapRef.current, panelRef, { side: 'beside', prefer: dir, nested: items.some(isFlyout), follow: parentAt });

  useLayoutEffect(() => { if (isOpen) state.register(panelRef.current); }, [isOpen, state]);
  useEffect(() => {
    if (!isOpen || !state.takeKeyboardOpen()) return;
    if (panelRef.current) focusInPanel(panelItems(panelRef.current)[0]);
  }, [isOpen, state]);

  const closeToRow = (e: ReactKeyboardEvent) => {
    if (!isOpen || (e.key !== 'Escape' && e.key !== 'ArrowLeft')) return;
    e.preventDefault();
    e.stopPropagation();
    state.hide();
    focusInPanel(rowRef.current);
  };

  return (
    <div ref={wrapRef} onMouseEnter={e => state.hover(section, { x: e.clientX, y: e.clientY })} onMouseLeave={state.later} onKeyDown={closeToRow}>
      <button
        ref={rowRef}
        type="button"
        data-nav-row
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        className={sectionCls(isOpen)}
        onClick={e => state.show(section, e.detail === 0)}
        onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); state.show(section, true); } }}
      >
        <span className="font-medium">{section}</span>
        <ChevronRight className="h-3.5 w-3.5 ml-6 flex-shrink-0" aria-hidden="true" />
      </button>
      {isOpen && (
        <div ref={panelRef} id={panelId} data-nav-panel onMouseEnter={state.cancel} onMouseLeave={state.later}
          onKeyDown={panelArrowKeys} style={place.style} className={panelCls(place.dir)}>
          <SubMenuItems items={items} asPath={asPath} onClose={onClose} accent={accent} dir={place.dir} parentAt={place.at} />
        </div>
      )}
    </div>
  );
}

// ─── Sub-panel contents ───────────────────────────────────────────────────────

interface SubMenuItemsProps {
  items: NavItem[];
  asPath: string;
  onClose: () => void;
  accent: AccentTokens;
  dir?: FlyoutDir;
  parentAt?: string;
}

export function SubMenuItems({ items, asPath, onClose, accent, dir = 'right', parentAt = '' }: SubMenuItemsProps) {
  const state = useOpenSection();
  const activeHref = activeHrefAmong(items, asPath);

  return (
    <>
      {items.map(item => {
        if (isFlyout(item)) {
          return <SectionGroup key={item.section} section={item.section} items={item.items}
            asPath={asPath} onClose={onClose} accent={accent} state={state} dir={dir} parentAt={parentAt} />;
        }
        if (item.isSetting) {
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-t border-line mt-1 pt-2 whitespace-nowrap transition-colors ${settingLinkCls(item.href === activeHref, accent)}`}
            >
              <Settings className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              {item.label}
            </Link>
          );
        }
        return (
          <Link key={item.href} href={item.href} onClick={onClose} className={makeLinkCls(item.href === activeHref, accent)}>
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

// ─── Top-level dropdowns ──────────────────────────────────────────────────────

interface DropdownProps {
  asPath: string;
  onClose: () => void;
  accent: AccentTokens;
  id?: string;
}

export function FlatDropdown({ items, asPath, onClose, accent, id }: DropdownProps & { items: DropdownItem[] }) {
  const activeHref = activeHrefAmong(items, asPath);
  const panelRef = useRef<HTMLDivElement>(null);
  const place = useFlyoutPlacement(true, () => panelRef.current?.parentElement, panelRef, { side: 'below' });
  return (
    <div ref={panelRef} id={id} data-nav-panel onKeyDown={panelArrowKeys} style={place.style}
      className="bg-surface-raised border border-line rounded-b-lg shadow-xl min-w-[220px] w-min py-1 z-40">
      {items.map(item => (
        <Link key={item.href} href={item.href} onClick={onClose} className={makeLinkCls(item.href === activeHref, accent)}>
          {item.label}
        </Link>
      ))}
    </div>
  );
}

export function FlyoutDropdown({ tab, asPath, onClose, accent, id }: DropdownProps & { tab: Tab }) {
  const state = useOpenSection();
  const allSections = (tab.items ?? []).filter(isFlyout);
  // Settings sections render inline (no flyout chevron) — all items are isSetting links
  const settingsItems = allSections.filter(s => s.section === 'Settings').flatMap(s => s.items);
  const settingsActiveHref = activeHrefAmong(settingsItems, asPath);
  const regularSections = allSections.filter(s => s.section !== 'Settings');
  const panelRef = useRef<HTMLDivElement>(null);
  // Anchored to the zero-size wrapper, which sits at the tab's bottom-left corner.
  const place = useFlyoutPlacement(true, () => panelRef.current?.parentElement, panelRef, { side: 'below' });

  return (
    <div id={id} className="absolute top-full left-0 z-40">
      <div ref={panelRef} data-nav-panel onKeyDown={panelArrowKeys} style={place.style}
        className="bg-surface-raised border border-line rounded-b-lg shadow-xl min-w-[200px] w-min py-1">
        <NavLinksBlock
          links={tab.links}
          tabItems={tab.items}
          asPath={asPath}
          onNav={onClose}
          linkClassName={active => makeLinkCls(active, accent)}
          separatorClassName="border-t border-line my-1"
        />
        {tab.topItems?.map(item => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className="block px-4 py-2 text-sm text-ink-muted hover:text-ink hover:bg-surface-sunken transition-colors"
          >
            {item.label}
          </Link>
        ))}
        {tab.topItems && tab.topItems.length > 0 && (
          <div className="border-t border-line my-1" />
        )}

        {regularSections.map(section => (
          <SectionGroup key={section.section} section={section.section} items={section.items}
            asPath={asPath} onClose={onClose} accent={accent} state={state} dir={place.dir} parentAt={place.at} />
        ))}

        {/* Settings items — rendered inline with separator, no flyout */}
        {settingsItems.map(item => {
          if (isFlyout(item)) return null;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={`flex items-center gap-2 px-4 py-2 text-sm border-t border-line mt-1 whitespace-nowrap transition-colors ${settingLinkCls(item.href === settingsActiveHref, accent)}`}
            >
              <Settings className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
