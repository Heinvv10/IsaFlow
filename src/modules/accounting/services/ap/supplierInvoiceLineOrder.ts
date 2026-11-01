/**
 * The order a supplier invoice's lines are read in. One definition for both TypeScript readers
 * (supplierInvoiceService.getSupplierInvoice, supplierInvoiceDraftUpdateGuards.planLines): the invoice screen's
 * line numbers, the posting order (buildExpenseLines puts the rounding residual on the LAST line) and a refusal's
 * "stored line N" must agree. Lines inserted together tie on created_at, so the content (then id) breaks the tie
 * instead of heap order.
 *
 * Migration 708's approval_document_digest hashes the lines in exactly this order and cannot import it:
 * tests/unit/services/ap/supplierInvoiceLineOrderMatches708.test.ts pins the two together. The table must be
 * aliased `sii` in the query this is spliced into (`sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)`).
 */
export const SUPPLIER_INVOICE_LINE_ORDER_BY =
  'ORDER BY sii.created_at, sii.description, sii.gl_account_id, sii.quantity, '
  + 'sii.unit_price, sii.tax_rate, sii.tax_amount, sii.line_total, '
  + 'sii.project_id, sii.cost_center_id, sii.vat_classification, sii.id';
