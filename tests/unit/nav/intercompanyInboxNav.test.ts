/** The Bills > Intercompany inbox page is in the nav (Purchases > Transactions), titled, and lights the Purchases module. */
import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { isFlyout, type DropdownItem, type NavItem } from '@/components/accounting/navSections/types';
import { buildPageIndex } from '@/components/accounting/navSections/pageRegistry';
import { getActiveModuleId } from '@/components/accounting/navSections/activeTab';
import { documentTitle } from '@/components/layout/shellRoutes';

const HREF = '/accounting/supplier-invoices/intercompany';

interface Found { tabId: string; sections: string[]; siblings: NavItem[]; item: DropdownItem }

/** Every place `href` appears in the nav tree: the item, the tab it is under, the sections between, and the items beside it. */
function findItems(href: string): Found[] {
  const found: Found[] = [];
  const walk = (tabId: string, sections: string[], items: NavItem[]) => {
    for (const entry of items) {
      if (isFlyout(entry)) walk(tabId, [...sections, entry.section], entry.items);
      else if (entry.href === href) found.push({ tabId, sections, siblings: items, item: entry });
    }
  };
  for (const tab of TABS) {
    walk(tab.id, [], tab.items ?? []);
    for (const link of [...(tab.links ?? []), ...(tab.topItems ?? [])]) if (link.href === href) found.push({ tabId: tab.id, sections: [], siblings: [], item: link });
  }
  return found;
}

describe('intercompany inbox nav entry', () => {
  it('is under Transactions of Purchases, next to Invoices', () => {
    const found = findItems(HREF);
    expect(found.map((f) => f.tabId).sort()).toEqual(['library', 'purchases']); // Purchases once; the Library tab lists every page
    const { tabId, sections, siblings, item } = found.find((f) => f.tabId === 'purchases')!;
    expect(item.label).toBe('Intercompany Inbox');
    expect(tabId).toBe('purchases');
    expect(sections).toEqual(['Transactions']);
    const at = siblings.indexOf(item);
    expect(siblings[at - 1]).toMatchObject({ label: 'Invoices', href: '/accounting/supplier-invoices' });
  });

  it('lights the Purchases module and has the document title of its label', () => {
    expect(getActiveModuleId(HREF, {})).toBe('purchases');
    expect(documentTitle(HREF, buildPageIndex(true))).toMatch(/^Intercompany Inbox · /);
  });
});
