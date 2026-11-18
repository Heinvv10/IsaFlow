/**
 * A main-row menu lists its daily links and then its section rows. A daily link labelled like a section ("Suppliers"
 * link above the "Suppliers" section) shows the same word twice in one menu, so no daily link may share a label with a
 * section of the same tab. The sections keep their names (the sidebar, Library and the remaining section bars use
 * them); the daily link is the one that says what it opens.
 */
import { describe, expect, it } from 'vitest';
import { TABS, settingsTab } from '@/components/accounting/accountingNavConfig';
import { isFlyout } from '@/components/accounting/navSections/types';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';

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
    expect(link('banking', '/accounting/bank-transactions')).toBe('Transaction List');
  });

  // A daily link's label becomes an alias of its page in the command palette's index. Named like ANOTHER page, it ties
  // that page in the ranking ("Bank Transactions" on the Banking page against the Bank Transactions report).
  // Sales and Purchases' "Invoices" and "Credit Notes" predate this rule (base 521682f65d): the Sales link and the
  // Purchases page share the name, and the reverse. They are listed so that any new collision fails here.
  it.each([true, false])('no daily link is named like a different page in the nav index (VAT vendor: %s)', (vat) => {
    const index = buildNavIndex([...TABS, settingsTab], vat);
    const clashes = TABS.flatMap((t) => (t.links ?? []).flatMap((l) => index
      .filter((e) => e.href !== l.href && (e.label === l.label || (e.aliases ?? []).includes(l.label)))
      .map((e) => `${t.id} "${l.label}" ${l.href} ~ ${e.href}`)));
    expect(clashes).toEqual([
      'sales "Invoices" /accounting/customer-invoices ~ /accounting/supplier-invoices',
      'sales "Credit Notes" /accounting/credit-notes ~ /accounting/supplier-credit-notes',
      'purchases "Invoices" /accounting/supplier-invoices ~ /accounting/customer-invoices',
      'purchases "Credit Notes" /accounting/supplier-credit-notes ~ /accounting/credit-notes',
    ]);
  });
});
