/**
 * Where a journal line links from a drill (budgets P3 §2.6: variance → GL lines
 * → source document). A journal posted from a document (the account
 * transactions service reports it as `document` when asked) links to that
 * document's page; any other posted journal links to its own journal-entry
 * page; a derived row (a year-end close) links nowhere. `returnTo`, an in-app
 * path ('/accounting/…'), rides along as `return_to`; anything else is dropped.
 * Pure and browser-safe.
 */
import type { JournalDocumentKind, JournalDocumentRef } from '@/modules/accounting/services/gl/journalDocuments';

const DOCUMENT_ROUTE: Record<JournalDocumentKind, { path: string; label: string }> = {
  customer_invoice: { path: '/accounting/customer-invoices', label: 'Customer invoice' },
  credit_note: { path: '/accounting/credit-notes', label: 'Credit note' },
  customer_payment: { path: '/accounting/customer-payments', label: 'Customer payment' },
  supplier_invoice: { path: '/accounting/supplier-invoices', label: 'Supplier invoice' },
  supplier_credit_note: { path: '/accounting/supplier-credit-notes', label: 'Supplier credit note' },
  supplier_payment: { path: '/accounting/supplier-payments', label: 'Supplier payment' },
};

const inApp = (path: string) => path.startsWith('/accounting/') && !path.startsWith('//');

export function journalSourceHref(
  row: { journalId?: string; document?: JournalDocumentRef | null }, returnTo?: string,
): { href: string; label: string } | null {
  const back = returnTo && inApp(returnTo) ? `?return_to=${encodeURIComponent(returnTo)}` : '';
  if (row.document) {
    const route = DOCUMENT_ROUTE[row.document.kind];
    return { href: `${route.path}/${encodeURIComponent(row.document.id)}${back}`, label: route.label };
  }
  if (row.journalId) return { href: `/accounting/journal-entries/${encodeURIComponent(row.journalId)}${back}`, label: 'Journal entry' };
  return null;
}
