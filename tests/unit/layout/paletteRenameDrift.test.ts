/**
 * Renaming four daily links (Customers -> Customer List, Suppliers -> Supplier List, Employees -> Employee List,
 * Transactions -> Transaction List) changes the aliases the palette ranks by. The palette's top page must stay what it
 * was for every query except those that spell out a new name. "Base" is today's config with those four links mapped
 * back to their old labels, so the comparison follows any later change to the rest of the nav.
 *
 * Queries: every label, alias and trail name of either index, each prefix of 3+ characters, lower and upper case;
 * VAT vendor and not.
 */
import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { NAV_FLAGS } from '@/components/accounting/navSections/flagNav';
import { rankPages } from '@/components/layout/paletteRank';
import type { Tab } from '@/components/accounting/navSections/types';

const OLD_LABEL: Record<string, string> = {
  'Customer List': 'Customers', 'Supplier List': 'Suppliers', 'Employee List': 'Employees', 'Transaction List': 'Transactions',
};
const BASE: Tab[] = TABS.map((t) => (t.links ? { ...t, links: t.links.map((l) => ({ ...l, label: OLD_LABEL[l.label] ?? l.label })) } : t));

/**
 * The only queries whose top page changes, lower-cased, with the page they now open: each is a prefix of a new name
 * past the old one, and opens that renamed link's own page. "employee l" used to open Employee Loans.
 */
const EXPECTED: Record<string, string> = {
  'customer li': '/accounting/customers', 'customer lis': '/accounting/customers', 'customer list': '/accounting/customers',
  'supplier li': '/accounting/suppliers', 'supplier lis': '/accounting/suppliers', 'supplier list': '/accounting/suppliers',
  'employee l': '/payroll/employees', 'employee li': '/payroll/employees', 'employee lis': '/payroll/employees', 'employee list': '/payroll/employees',
  'transaction l': '/accounting/bank-transactions', 'transaction li': '/accounting/bank-transactions',
  'transaction lis': '/accounting/bank-transactions', 'transaction list': '/accounting/bank-transactions',
};

const top = (index: ReturnType<typeof buildNavIndex>, q: string) => rankPages(index, q, 6)[0]?.href ?? '';

describe.each([true, false])('palette top page after the daily-link renames (VAT vendor: %s)', (vat) => {
  it('every query keeps its top page, except the listed prefixes of the new names', () => {
    const head = buildNavIndex(TABS, vat, new Set(NAV_FLAGS));
    const base = buildNavIndex(BASE, vat, new Set(NAV_FLAGS));
    expect(base).not.toEqual(head); // the mapping really undid the renames
    const names = new Set([...head, ...base].flatMap((e) => [e.label, ...(e.aliases ?? []), ...e.trail]));
    const queries = new Set([...names].flatMap((n) => Array.from({ length: Math.max(0, n.length - 2) }, (_, i) => n.slice(0, i + 3)))
      .flatMap((p) => [p.toLowerCase(), p.toUpperCase()]));
    expect(queries.size).toBeGreaterThan(4000);
    const changed: Record<string, string> = {};
    for (const q of queries) if (top(base, q) !== top(head, q)) changed[q] = top(head, q);
    const expected = Object.fromEntries(Object.entries(EXPECTED).flatMap(([q, href]) => [[q, href], [q.toUpperCase(), href]]));
    expect(changed).toEqual(expected);
  });
});
