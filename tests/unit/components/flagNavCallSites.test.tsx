/**
 * Every place the nav is drawn applies `stripFlagNav` (budgets P6 spec §13.14): the three-way budget link shows
 * only for a company with `budgets_three_way`. One case per call site, flag off and on, so a site that drops the
 * filter (or applies it to the wrong tree) fails here. The fifth site, `navIndex`, is pinned in tests/unit/flagNav.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { isFlyout, type NavItem, type Tab } from '@/components/accounting/navSections/types';

const h = vi.hoisted(() => ({ flags: new Set<string>() as ReadonlySet<string>, moduleTabs: [] as Tab[][] }));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => h.flags }));

import { AccountingNav } from '@/components/accounting/AccountingNav';
import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';
import { DrawerNav } from '@/components/layout/DrawerNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { THREE_WAY_HREF } from '@/components/accounting/navSections/flagNav';

vi.mock('@/components/layout/ModuleNav', () => ({
  ModuleNav: ({ tabs }: { tabs: Tab[] }) => { h.moduleTabs.push(tabs); return null; },
}));

const ON: ReadonlySet<string> = new Set(['budgets_three_way']);
const OFF: ReadonlySet<string> = new Set();

function hrefs(items: NavItem[] | undefined): string[] {
  if (!items) return [];
  return items.flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));
}
const allHrefs = (tabs: Tab[]): string[] =>
  tabs.flatMap((t) => [...(t.href ? [t.href] : []), ...hrefs(t.items), ...hrefs(t.topItems), ...hrefs(t.links)]);
const lastModuleHrefs = () => allHrefs(h.moduleTabs.at(-1) ?? []);
const threeWayLinks = () => document.querySelectorAll(`a[href="${THREE_WAY_HREF}"]`).length;

afterEach(() => { cleanup(); h.moduleTabs = []; h.flags = OFF; });

describe.each([
  ['flag off', OFF, false],
  ['flag on', ON, true],
] as const)('%s', (_name, flags, shown) => {
  it('AccountingNav (the top bar) hands ModuleNav the filtered tabs', () => {
    h.flags = flags;
    render(<AccountingNav />);
    expect(lastModuleHrefs().includes(THREE_WAY_HREF)).toBe(shown);
  });

  it('SecondaryModuleNav (the Accounting module bar) filters its section tabs', () => {
    h.flags = flags;
    render(<SecondaryModuleNav moduleId="accounting" />);
    expect(lastModuleHrefs().includes(THREE_WAY_HREF)).toBe(shown);
  });

  it('DrawerNav: Library > Accounting > Management Accounting', () => {
    h.flags = flags;
    render(<DrawerNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accounting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Management Accounting' }));
    expect(screen.getByRole('link', { name: 'Budget Controls' })).toBeTruthy();
    expect(threeWayLinks() > 0).toBe(shown);
  });

  it('SidebarNav: Library > Accounting > Management Accounting flyouts', () => {
    h.flags = flags;
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-library'));
    const row = (name: string) => screen.getAllByRole('button', { name }).at(-1)!.parentElement!;
    fireEvent.mouseEnter(row('Accounting'));
    fireEvent.mouseEnter(row('Management Accounting'));
    expect(screen.getByRole('link', { name: 'Budget Controls' })).toBeTruthy();
    expect(threeWayLinks() > 0).toBe(shown);
  });
});
