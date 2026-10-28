/**
 * Where a journal line links from a drill (budgets P3 §2.6: variance → GL lines
 * → source document). A journal posted from a document (the account
 * transactions service reports it as `document`) links to that document's
 * page; any other posted journal links to its own journal-entry page; a
 * derived row (a year-end close) links nowhere. Pure and browser-safe.
 */
import type { JournalDocumentKind, JournalDocumentRef } from '@/modules/accounting/services/gl/accountTransactionsService';

const DOCUMENT_ROUTE: Record<JournalDocumentKind, { path: string; label: string }> = {
  customer_invoice: { path: '/accounting/customer-invoices', label: 'Customer invoice' },
  credit_note: { path: '/accounting/credit-notes', label: 'Credit note' },
  customer_payment: { path: '/accounting/customer-payments', label: 'Customer payment' },
  supplier_invoice: { path: '/accounting/supplier-invoices', label: 'Supplier invoice' },
  supplier_payment: { path: '/accounting/supplier-payments', label: 'Supplier payment' },
};

export function journalSourceHref(row: { journalId?: string; document?: JournalDocumentRef | null }): { href: string; label: string } | null {
  if (row.document) {
    const route = DOCUMENT_ROUTE[row.document.kind];
    return { href: `${route.path}/${encodeURIComponent(row.document.id)}`, label: route.label };
  }
  if (row.journalId) return { href: `/accounting/journal-entries/${encodeURIComponent(row.journalId)}`, label: 'Journal entry' };
  return null;
}
