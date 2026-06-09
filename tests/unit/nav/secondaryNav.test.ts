import { describe, it, expect } from 'vitest';
import { moduleSectionsToTabs, isSectionActive } from '@/components/accounting/navSections/secondaryNav';
import { salesTab } from '@/components/accounting/navSections/sales';

describe('moduleSectionsToTabs', () => {
  it('turns each module flyout section into a dropdown tab', () => {
    const tabs = moduleSectionsToTabs(salesTab);
    expect(tabs.map((t) => t.label)).toEqual(['Customers', 'Transactions', 'Reports', 'Statement Run']);
    // each becomes a no-href dropdown carrying the section's items
    expect(tabs[0]!.href).toBeUndefined();
    expect(tabs[0]!.items!.length).toBeGreaterThan(0);
  });
});

describe('isSectionActive', () => {
  it('is active when any nested link matches the path', () => {
    const customers = moduleSectionsToTabs(salesTab)[0]!;
    expect(isSectionActive(customers, '/accounting/customers')).toBe(true);
    expect(isSectionActive(customers, '/accounting/items')).toBe(false);
  });
});
