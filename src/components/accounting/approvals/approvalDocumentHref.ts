/**
 * R-035: where the document an approval request was raised for lives in the
 * app, so the approvals list can link to it. Only types with a detail page
 * are mapped; anything else (the legacy `credit_note` type included, which
 * cannot say which page its note is on) gets no link.
 */
const PAGES: Record<string, string> = {
  supplier_invoice: '/accounting/supplier-invoices',
  customer_credit_note: '/accounting/credit-notes',
  supplier_credit_note: '/accounting/supplier-credit-notes',
  customer_invoice: '/accounting/customer-invoices',
};

export function approvalDocumentHref(documentType: string, documentId: string): string | null {
  const base = PAGES[documentType];
  return base ? `${base}/${documentId}` : null;
}
