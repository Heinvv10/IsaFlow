/**
 * Bank Feeds was folded into Statement Imports (11 Nov 2026 audit, item b.5).
 * IsaFlow imports statements the user uploads; it has no live bank feed, so
 * no nav entry may offer one, and Statement Imports must stay reachable.
 */
import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { bankingTab } from '@/components/accounting/navSections/banking';
import { isFlyout, type DropdownItem, type NavItem, type Tab } from '@/components/accounting/navSections/types';

const flatten = (items: NavItem[]): DropdownItem[] => items.flatMap((i) => (isFlyout(i) ? flatten(i.items) : [i]));
const linksOf = (t: Tab): DropdownItem[] => [...(t.links ?? []), ...(t.topItems ?? []), ...flatten(t.items ?? [])];

describe('nav: Bank Feeds folded into Statement Imports', () => {
  it('the Banking tab has no Bank Feeds item', () => {
    for (const l of linksOf(bankingTab)) {
      expect(l.label, l.href).not.toMatch(/bank feed/i);
      expect(l.href, l.label).not.toContain('bank-feeds');
    }
  });

  it('Statement Imports is in the Banking tab', () => {
    const si = linksOf(bankingTab).filter((l) => l.label === 'Statement Imports');
    expect(si).toHaveLength(1);
    expect(si[0]!.href).toBe('/accounting/bank/statements');
  });

  it('no tab links to /accounting/bank-feeds', () => {
    for (const tab of TABS) {
      expect(tab.href).not.toContain('bank-feeds');
      for (const l of linksOf(tab)) expect(l.href, `${tab.id}: ${l.label}`).not.toContain('bank-feeds');
    }
  });
});
