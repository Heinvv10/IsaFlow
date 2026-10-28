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
  });
});
