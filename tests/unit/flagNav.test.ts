/**
 * The nav filter that hides feature-flagged pages (budgets P6 spec §13.14): the three-way budget link is in the
 * Management Accounting menus, and a company without `budgets_three_way` must not see it anywhere the nav renders.
 * The five call sites are pinned in tests/unit/components/flagNavCallSites.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { flagOfHref, NAV_FLAGS, stripFlagNav, THREE_WAY_HREF } from '@/components/accounting/navSections/flagNav';
import { TABS, settingsTab } from '@/components/accounting/accountingNavConfig';
import { accountingTab } from '@/components/accounting/navSections/accounting';
import { accountantsTab } from '@/components/accounting/navSections/accountants';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { isFlyout, type NavItem, type Tab } from '@/components/accounting/navSections/types';

const ON = new Set(NAV_FLAGS);
const OFF: ReadonlySet<string> = new Set();

function hrefs(items: NavItem[] | undefined): string[] {
  if (!items) return [];
  return items.flatMap((i) => (isFlyout(i) ? hrefs(i.items) : [i.href]));
}
const allHrefs = (tabs: Tab[]): string[] =>
  tabs.flatMap((t) => [...(t.href ? [t.href] : []), ...hrefs(t.items), ...hrefs(t.topItems), ...hrefs(t.links)]);

describe('flagOfHref', () => {
  it('names the flag of the three-way page, query strings ignored', () => {
    expect(flagOfHref(THREE_WAY_HREF)).toBe('budgets_three_way');
    expect(flagOfHref(`${THREE_WAY_HREF}?version_id=x`)).toBe('budgets_three_way');
  });
  it('leaves the other budget pages alone', () => {
    expect(flagOfHref('/accounting/budgets')).toBeNull();
    expect(flagOfHref('/accounting/budgets/controls')).toBeNull();
    expect(flagOfHref('/accounting/budgets/three-way-other')).toBeNull();
  });
});

describe('stripFlagNav', () => {
  it('the link is in both Management menus (accounting and accountants)', () => {
    expect(allHrefs([accountingTab])).toContain(THREE_WAY_HREF);
    expect(allHrefs([accountantsTab])).toContain(THREE_WAY_HREF);
  });

  it('flag on: the same tabs, untouched', () => {
    expect(stripFlagNav(TABS, ON)).toBe(TABS);
    expect(stripFlagNav([accountingTab, accountantsTab], ON)).toEqual([accountingTab, accountantsTab]);
  });

  it('flag off: the link is gone from every tab, nothing else is', () => {
    const before = allHrefs([...TABS, accountingTab, accountantsTab, settingsTab]);
    const after = allHrefs(stripFlagNav([...TABS, accountingTab, accountantsTab, settingsTab], OFF));
    expect(after).not.toContain(THREE_WAY_HREF);
    expect(after).toEqual(before.filter((h) => h !== THREE_WAY_HREF));
  });

  it('flag off: the Management Accounting section keeps its other links in order', () => {
    const section = stripFlagNav([accountingTab], OFF)[0]!.items!.find((i) => isFlyout(i) && i.section === 'Management Accounting');
    expect(section && isFlyout(section) ? section.items.map((i) => (isFlyout(i) ? i.section : i.label)) : null)
      .toEqual(['Cost Centres', 'Business Units', 'Budget Review', 'Budgets', 'Budget Controls']);
  });

  it('an unknown flag in the set enables nothing', () => {
    expect(allHrefs(stripFlagNav([accountingTab], new Set(['payroll'])))).not.toContain(THREE_WAY_HREF);
  });

  it('a section, flyout or tab left with no links goes; a tab with its own landing stays', () => {
    const only: Tab = { id: 'x', label: 'X', items: [{ section: 'S', items: [{ label: '3W', href: THREE_WAY_HREF }] }] };
    expect(stripFlagNav([only], OFF)).toEqual([]);
    const landing: Tab = { id: 'y', label: 'Y', href: '/accounting', links: [{ label: '3W', href: THREE_WAY_HREF }] };
    expect(stripFlagNav([landing], OFF)).toEqual([{ id: 'y', label: 'Y', href: '/accounting', links: [] }]);
    const flaggedLanding: Tab = { id: 'z', label: 'Z', href: THREE_WAY_HREF };
    expect(stripFlagNav([flaggedLanding], OFF)).toEqual([]);
    const topOnly: Tab = { id: 't', label: 'T', topItems: [{ label: '3W', href: THREE_WAY_HREF }] };
    expect(stripFlagNav([topOnly], OFF)).toEqual([]);
  });
});

describe('buildNavIndex applies it (the command palette and page titles read the index)', () => {
  it('no flags (the default): the page is not in the index', () => {
    expect(buildNavIndex([...TABS, accountingTab], true).map((e) => e.href)).not.toContain(THREE_WAY_HREF);
    expect(buildNavIndex([...TABS, accountingTab], true, OFF).map((e) => e.href)).not.toContain(THREE_WAY_HREF);
  });
  it('flag on: the page is indexed under Management Accounting', () => {
    const e = buildNavIndex([accountingTab], true, ON).find((x) => x.href === THREE_WAY_HREF);
    expect(e?.trail).toEqual(['Accounting', 'Management Accounting']);
  });
});
