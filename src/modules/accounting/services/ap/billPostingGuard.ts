/**
 * The pre-write checks both AP posting paths make before building a bill's
 * journal (`approveSupplierInvoice`, `postSupplierInvoiceToGL`): the stored
 * lines against the chart as it is now, and — FX PR0 — the bill's currency
 * columns while the company has not enabled foreign-currency documents. Kept
 * out of supplierInvoiceWorkflowService.ts, which is over the line cap.
 *
 * Approve also calls `assertBillApprovable` BEFORE its "draft already carries
 * a journal" reuse branch: that branch moves the status with no journal built,
 * so the currency check must precede it or the user meets the database gate's
 * raw text instead of the worded 400 (round-3 probe S).
 */
import type { SupplierInvoice } from '../../types/ap.types';
import { assertSupplierInvoiceLinesPostable } from './billLineAccountGuard';
import { assertStoredDocumentPostable } from '../shared/documentCurrency';
import { assertApprovalCleared } from '../gl/approvalGate';

/** Under the approve lock, before any write: the R-035 approval, then the FX PR0 currency rule. */
export async function assertBillApprovable(companyId: string, id: string): Promise<void> {
  await assertApprovalCleared(companyId, 'supplier_invoice', id);
  await assertStoredDocumentPostable(companyId, 'supplier_invoice', id);
}

export async function assertBillPostable(
  companyId: string,
  invoice: Pick<SupplierInvoice, 'id' | 'invoiceNumber' | 'items' | 'status'>,
): Promise<void> {
  await assertStoredDocumentPostable(companyId, 'supplier_invoice', invoice.id);
  await assertSupplierInvoiceLinesPostable(companyId, invoice);
}
