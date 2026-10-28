/**
 * Budgets P3 PR-B (T10, spec §2.6): where a drill row links. A journal posted
 * from a document links to that document's page; any other journal to its own
 * journal-entry page. No existing helper did this (census: components/accounting/gl,
 * the account-detail page), so this is the one mapping.
 */
import { describe, expect, it } from 'vitest';
import { journalSourceHref } from '@/lib/journalSourceHref';

const J = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';

describe('journalSourceHref', () => {
  it.each([
    ['customer_invoice', `/accounting/customer-invoices/${D}`],
    ['credit_note', `/accounting/credit-notes/${D}`],
    ['customer_payment', `/accounting/customer-payments/${D}`],
    ['supplier_invoice', `/accounting/supplier-invoices/${D}`],
    ['supplier_credit_note', `/accounting/supplier-credit-notes/${D}`],
    ['supplier_payment', `/accounting/supplier-payments/${D}`],
  ] as const)('a %s journal links to its document', (kind, href) => {
    expect(journalSourceHref({ journalId: J, document: { kind, id: D } })).toEqual({ href, label: expect.any(String) });
  });

  it('a journal with no document links to the journal entry; a derived row links nowhere', () => {
    expect(journalSourceHref({ journalId: J, document: null })).toEqual({ href: `/accounting/journal-entries/${J}`, label: 'Journal entry' });
    expect(journalSourceHref({})).toBeNull();
  });

  it('ids are URI-encoded', () => {
    expect(journalSourceHref({ journalId: 'a/b' })?.href).toBe('/accounting/journal-entries/a%2Fb');
    expect(journalSourceHref({ journalId: J, document: { kind: 'customer_invoice', id: 'x/../y?z=1#w' } })?.href)
      .toBe('/accounting/customer-invoices/x%2F..%2Fy%3Fz%3D1%23w');
  });

  it('carries the report it was opened from as return_to, encoded; an outside URL is dropped', () => {
    const back = '/accounting/reports/budget-vs-actual?period=fy&fiscal_year=2027&cc1_id=abc';
    expect(journalSourceHref({ journalId: J, document: { kind: 'supplier_invoice', id: D } }, back)?.href)
      .toBe(`/accounting/supplier-invoices/${D}?return_to=${encodeURIComponent(back)}`);
    expect(journalSourceHref({ journalId: J }, back)?.href).toBe(`/accounting/journal-entries/${J}?return_to=${encodeURIComponent(back)}`);
    for (const bad of ['https://evil.example/accounting', '//evil.example/x', 'javascript:alert(1)']) {
      expect(journalSourceHref({ journalId: J }, bad)?.href).toBe(`/accounting/journal-entries/${J}`);
    }
  });
});
