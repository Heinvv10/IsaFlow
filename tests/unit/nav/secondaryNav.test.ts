import { describe, it, expect } from 'vitest';
import { moduleSectionsToTabs, isSectionActive, getActiveSectionId } from '@/components/accounting/navSections/secondaryNav';
import { salesTab } from '@/components/accounting/navSections/sales';
import { reportsTab } from '@/components/accounting/navSections/reports';
import { payrollTab } from '@/components/accounting/navSections/payroll';
import { purchasesTab } from '@/components/accounting/navSections/purchases';
import type { Tab } from '@/components/accounting/navSections/types';

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

  it('matches a link nested inside a sub-section (recursion)', () => {
    const nested: Tab = {
      id: 'Reports', label: 'Reports',
      items: [
        { section: 'Management', items: [{ label: 'Mgmt Pack', href: '/accounting/reports/mgmt' }] },
      ],
    };
    expect(isSectionActive(nested, '/accounting/reports/mgmt')).toBe(true);
    expect(isSectionActive(nested, '/accounting/reports/other')).toBe(false);
  });
});

describe('getActiveSectionId', () => {
  it('returns the active section id, or empty string when none match', () => {
    expect(getActiveSectionId(salesTab, '/accounting/customers')).toBe('Customers');
    expect(getActiveSectionId(salesTab, '/accounting/items')).toBe('');
  });
});

describe('isSectionActive on a sibling that shares a prefix', () => {
  it('does not light /accounting/customers for /accounting/customers-x', () => {
    const customers = moduleSectionsToTabs(salesTab)[0]!;
    expect(isSectionActive(customers, '/accounting/customers-x')).toBe(false);
    expect(isSectionActive(customers, '/accounting/customers/42')).toBe(true);
  });

  it('matches a section that is a bare link on a segment boundary', () => {
    const bare: Tab = { id: '/accounting/foo', label: 'Foo', href: '/accounting/foo' };
    expect(isSectionActive(bare, '/accounting/foobar')).toBe(false);
    expect(isSectionActive(bare, '/accounting/foo#top')).toBe(true);
  });
});

describe('getActiveSectionId when two sections both match the path', () => {
  // An AFS document and a management pack share /accounting/afs/<id>; only ?type=management_pack tells them apart.
  it('an AFS document lights Annual Financial Statements', () => {
    expect(getActiveSectionId(reportsTab, '/accounting/afs/2606788e')).toBe('Annual Financial Statements');
    expect(getActiveSectionId(reportsTab, '/accounting/afs')).toBe('Annual Financial Statements');
  });

  it('a management pack (its path carries ?type=management_pack) lights Management Packs, not AFS', () => {
    expect(getActiveSectionId(reportsTab, '/accounting/afs/ba60eeb5?type=management_pack')).toBe('Management Packs');
    expect(getActiveSectionId(reportsTab, '/accounting/afs?type=management_pack')).toBe('Management Packs');
  });

  it('the Management Packs pages themselves light Management Packs', () => {
    expect(getActiveSectionId(reportsTab, '/accounting/afs/management-packs')).toBe('Management Packs');
    expect(getActiveSectionId(reportsTab, '/accounting/afs/portal-contacts')).toBe('Management Packs');
  });

  it('the AFS-only pages stay under Annual Financial Statements', () => {
    expect(getActiveSectionId(reportsTab, '/accounting/afs/mapping')).toBe('Annual Financial Statements');
  });

  it('a tie goes to the earlier section; the deeper link wins in other modules too (pinned from the census)', () => {
    expect(getActiveSectionId(payrollTab, '/payroll/training/wsp-atr')).toBe('Reports');
    expect(getActiveSectionId(purchasesTab, '/accounting/suppliers/rules')).toBe('Capture');
    expect(getActiveSectionId(salesTab, '/accounting/customers/statement')).toBe('Reports');
    expect(getActiveSectionId(salesTab, '/accounting/customers/42')).toBe('Customers');
  });
});
