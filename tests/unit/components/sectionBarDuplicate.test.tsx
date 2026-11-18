/**
 * The per-module section bar (SecondaryModuleNav) shows only where it is not a duplicate. A module with its own
 * main-row tab (TABS) already opens every section from that tab's hover menu, so the bar repeats it; a module reached
 * only through Library (Inventory, Accounting, Practice) has no other always-visible menu and keeps its bar.
 *
 * The proof, per main-row module, for VAT vendor and non-vendor, flags on and off: every link the section bar can
 * show (every href in the module's sections, after the same stripping) is reachable in the REAL main-row menu, walked
 * by opening each section row of the rendered ModuleNav.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { panelItems } from '@/components/layout/ModuleNavMenus';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { MODULE_BY_ID, hasSectionBar } from '@/components/accounting/navSections/secondaryNav';
import { stripVatNav } from '@/components/accounting/navSections/vatNav';
import { stripFlagNav, NAV_FLAGS } from '@/components/accounting/navSections/flagNav';
import { isFlyout, type NavItem, type Tab } from '@/components/accounting/navSections/types';

afterEach(cleanup);

const MAIN_ROW = new Set(TABS.map((t) => t.id));
const ON_MAIN_ROW = Object.keys(MODULE_BY_ID).filter((id) => MAIN_ROW.has(id)).sort();
const LIBRARY_ONLY = Object.keys(MODULE_BY_ID).filter((id) => !MAIN_ROW.has(id)).sort();

const strip = (tabs: Tab[], vat: boolean, flags: ReadonlySet<string>) => stripFlagNav(stripVatNav(tabs, vat), flags);

function hrefs(items: NavItem[]): string[] {
  return items.flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));
}

/** Every href in the open panel and, row by row, in each sub-panel it opens. */
function walk(panel: HTMLElement, out: Set<string>): void {
  for (const el of panelItems(panel)) if (el.tagName === 'A') out.add(el.getAttribute('href')!);
  const rowLabels = panelItems(panel).filter((el) => el.matches('button[data-nav-row]')).map((el) => el.textContent);
  for (const label of rowLabels) {
    const row = panelItems(panel).find((el) => el.matches('button[data-nav-row]') && el.textContent === label)!;
    fireEvent.click(row);
    walk(document.getElementById(row.getAttribute('aria-controls')!)!, out);
  }
}

/** What the main row reaches for one module: its tab link plus everything inside its menu. */
function mainRowReach(tabs: Tab[], id: string): Set<string> {
  render(<ModuleNav tabs={tabs} getActiveTabId={() => 'dashboard'} accentColor="teal" ariaLabel="Main" />);
  const tab = tabs.find((t) => t.id === id)!;
  const out = new Set<string>(tab.href ? [tab.href] : []);
  fireEvent.click(screen.getByRole('button', { name: `${tab.label} menu` }));
  walk(document.querySelector<HTMLElement>(`[data-tour="nav-${id}"] [data-nav-panel]`)!, out);
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

  it('a page outside every module (dashboard, banking, settings) has no bar', () => {
    for (const id of ['dashboard', 'banking', 'settings', 'library', 'workbench', 'portfolio', '']) expect(hasSectionBar(id), id).toBe(false);
  });
});

describe.each([
  ['VAT vendor', true],
  ['not a VAT vendor', false],
] as const)('%s', (_vatName, vat) => {
  describe.each([
    ['flags on', new Set(NAV_FLAGS) as ReadonlySet<string>],
    ['flags off', new Set<string>() as ReadonlySet<string>],
  ] as const)('%s', (_flagName, flags) => {
    it.each(ON_MAIN_ROW)('%s: every link of its section bar is reachable from its main-row menu', (id) => {
      const module = strip([MODULE_BY_ID[id]!], vat, flags)[0]!;
      const bar = new Set(hrefs(module.items ?? []));
      expect(bar.size).toBeGreaterThan(0);
      const reach = mainRowReach(strip(TABS, vat, flags), id);
      expect([...bar].filter((href) => !reach.has(href))).toEqual([]);
    });
  });
});
