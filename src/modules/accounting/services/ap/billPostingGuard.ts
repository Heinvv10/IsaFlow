/**
 * The pre-write checks both AP posting paths make before building a bill's
 * journal (`approveSupplierInvoice`, `postSupplierInvoiceToGL`): the stored
 * lines against the chart as it is now, and — FX PR0 — the bill's currency
 * columns while the company has not enabled foreign-currency documents. Kept
 * out of supplierInvoiceWorkflowService.ts, which is over the line cap.
 */
import type { SupplierInvoice } from '../../types/ap.types';
import { assertSupplierInvoiceLinesPostable } from './billLineAccountGuard';
import { assertStoredDocumentPostable } from '../shared/documentCurrency';

export async function assertBillPostable(
  companyId: string,
  invoice: Pick<SupplierInvoice, 'id' | 'invoiceNumber' | 'items'>,
): Promise<void> {
  await assertStoredDocumentPostable(companyId, 'supplier_invoice', invoice.id);
  await assertSupplierInvoiceLinesPostable(companyId, invoice);
}
