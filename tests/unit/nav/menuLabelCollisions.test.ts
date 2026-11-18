/**
 * A main-row menu lists its daily links and then its section rows. A daily link labelled like a section ("Suppliers"
 * link above the "Suppliers" section) shows the same word twice in one menu, so no daily link may share a label with a
 * section of the same tab. The sections keep their names (the sidebar, Library and the remaining section bars use
 * them); the daily link is the one that says what it opens.
 */
import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { isFlyout } from '@/components/accounting/navSections/types';

describe('main-row menu labels', () => {
  it.each(TABS.filter((t) => t.links?.length).map((t) => [t.id, t] as const))('%s: no daily link is named like a section', (_id, tab) => {
    const sections = new Set((tab.items ?? []).filter(isFlyout).map((s) => s.section));
    expect((tab.links ?? []).map((l) => l.label).filter((label) => sections.has(label))).toEqual([]);
  });

  it('the list pages keep a daily link, under a name of their own', () => {
    const link = (id: string, href: string) => TABS.find((t) => t.id === id)?.links?.find((l) => l.href === href)?.label;
    expect(link('sales', '/accounting/customers')).toBe('Customer List');
    expect(link('purchases', '/accounting/suppliers')).toBe('Supplier List');
    expect(link('payroll', '/payroll/employees')).toBe('Employee List');
    expect(link('banking', '/accounting/bank-transactions')).toBe('Bank Transactions');
  });
});
