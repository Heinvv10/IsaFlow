/**
 * The per-module section bar (SecondaryModuleNav) shows only where it is not a duplicate. A module with its own
 * main-row tab (TABS) already opens every section from that tab's hover menu, so the bar repeats it; a module reached
 * only through Library (Inventory, Accounting, Practice) has no other always-visible menu and keeps its bar.
 *
 * The proof, per main-row module, for a VAT vendor and a non-vendor, nav flags on and off: every link the section bar
 * can show (every href in the module's sections, after the same stripping) is reachable in the REAL main row
 * (AccountingNav, top mode) and in the REAL sidebar (SidebarNav, side mode), walked by opening every section row at
 * every level.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ vat: true, flags: new Set<string>() as ReadonlySet<string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: h.vat, known: true }) }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => h.flags }));

import { AccountingNav } from '@/components/accounting/AccountingNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { panelItems } from '@/components/layout/ModuleNavMenus';
import { TABS, getActiveModuleId, getActiveTabId } from '@/components/accounting/accountingNavConfig';
import { MODULE_BY_ID, hasSectionBar } from '@/components/accounting/navSections/secondaryNav';
import { stripVatNav } from '@/components/accounting/navSections/vatNav';
import { stripFlagNav, NAV_FLAGS, MODULE_READ_NAV_FLAGS } from '@/components/accounting/navSections/flagNav';
import { isFlyout, type NavItem, type Tab } from '@/components/accounting/navSections/types';

afterEach(cleanup);

const MAIN_ROW = new Set(TABS.map((t) => t.id));
const ON_MAIN_ROW = Object.keys(MODULE_BY_ID).filter((id) => MAIN_ROW.has(id)).sort();
const LIBRARY_ONLY = Object.keys(MODULE_BY_ID).filter((id) => !MAIN_ROW.has(id)).sort();

const strip = (tabs: Tab[]) => stripFlagNav(stripVatNav(tabs, h.vat), h.flags);

function hrefs(items: NavItem[]): string[] {
  return items.flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));
}

/** What the module's section bar offers: every link in its (stripped) sections, at every level. */
function barLinks(id: string): string[] {
  return [...new Set(hrefs(strip([MODULE_BY_ID[id]!])[0]?.items ?? []))];
}

/** Top mode: every href in an open ModuleNav panel and, row by row, in each sub-panel it opens. */
function walkTop(panel: HTMLElement, out: Set<string>): void {
  for (const el of panelItems(panel)) if (el.tagName === 'A') out.add(el.getAttribute('href')!);
  const labels = panelItems(panel).filter((el) => el.matches('button[data-nav-row]')).map((el) => el.textContent);
  for (const label of labels) {
    const row = panelItems(panel).find((el) => el.matches('button[data-nav-row]') && el.textContent === label)!;
    fireEvent.click(row);
    walkTop(document.getElementById(row.getAttribute('aria-controls')!)!, out);
  }
}

function topReach(id: string): Set<string> {
  render(<AccountingNav />);
  const tab = strip(TABS).find((t) => t.id === id)!;
  const out = new Set<string>(tab.href ? [tab.href] : []);
  fireEvent.click(screen.getByRole('button', { name: `${tab.label} menu` }));
  walkTop(document.querySelector<HTMLElement>(`[data-tour="nav-${id}"] [data-nav-panel]`)!, out);
  cleanup();
  return out;
}

const flyouts = () => new Set(document.querySelectorAll<HTMLElement>('[data-sidebar-flyout]'));

/** Side mode: the sidebar's panels are portals on <body>, so a row's sub-panel is the one that appears when it opens. */
function walkSide(panel: HTMLElement, out: Set<string>): void {
  for (const a of panel.querySelectorAll('a[href]')) out.add(a.getAttribute('href')!);
  const labels = [...panel.querySelectorAll('[data-flyout-row]')].map((el) => el.textContent);
  for (const label of labels) {
    const row = [...panel.querySelectorAll<HTMLElement>('[data-flyout-row]')].find((el) => el.textContent === label)!;
    const before = flyouts();
    fireEvent.click(row);
    const opened = [...flyouts()].filter((el) => !before.has(el));
    expect(opened, `side row "${label}" opens one panel`).toHaveLength(1);
    walkSide(opened[0]!, out);
  }
}

function sideReach(id: string): Set<string> {
  render(<SidebarNav />);
  const tabEl = screen.getByTestId(`sidebar-tab-${id}`);
  const out = new Set<string>([tabEl.getAttribute('href')].filter((x): x is string => !!x));
  fireEvent.mouseEnter(tabEl);
  const [panel] = flyouts();
  walkSide(panel!, out);
  cleanup();
  return out;
}

describe('section bar placement', () => {
  it('the modules on the main row lose the bar; the Library-only modules keep it', () => {
    expect(ON_MAIN_ROW).toEqual(['payroll', 'purchases', 'reports', 'sales', 'tax']);
    expect(LIBRARY_ONLY).toEqual(['accounting', 'inventory', 'practice']);
    for (const id of ON_MAIN_ROW) expect(hasSectionBar(id), id).toBe(false);
    for (const id of LIBRARY_ONLY) expect(hasSectionBar(id), id).toBe(true);
  });

  it('a page outside every module (dashboard, banking, settings, bureau) has no bar', () => {
    for (const id of ['dashboard', 'banking', 'settings', 'library', 'workbench', 'portfolio', 'bureau', '']) expect(hasSectionBar(id), id).toBe(false);
  });

  // On a page whose bar goes, the main row still says which module it is in: its own tab lights, not Library.
  it.each(ON_MAIN_ROW)('%s: every bar page that belongs to the module lights its main-row tab', (id) => {
    for (const href of hrefs(MODULE_BY_ID[id]!.items ?? [])) {
      const [path, qs = ''] = href.split('?') as [string, string?];
      const query = Object.fromEntries(new URLSearchParams(qs));
      if (getActiveModuleId(path, query) === id) expect(getActiveTabId(path, query), href).toBe(id);
    }
  });
});

describe.each([
  ['VAT vendor', true],
  ['not a VAT vendor', false],
] as const)('%s', (_vatName, vat) => {
  describe.each([
    ['flags on', new Set(NAV_FLAGS) as ReadonlySet<string>],
    ['flags off', new Set(MODULE_READ_NAV_FLAGS) as ReadonlySet<string>],
  ] as const)('%s', (_flagName, flags) => {
    it.each(ON_MAIN_ROW)('%s: every link of its section bar is reachable from the main-row menu and the sidebar', (id) => {
      h.vat = vat;
      h.flags = flags;
      const bar = barLinks(id);
      expect(bar.length).toBeGreaterThan(0);
      const top = topReach(id);
      expect(bar.filter((href) => !top.has(href)), 'missing from the top-nav menu').toEqual([]);
      const side = sideReach(id);
      expect(bar.filter((href) => !side.has(href)), 'missing from the sidebar flyout').toEqual([]);
    });
  });
});
