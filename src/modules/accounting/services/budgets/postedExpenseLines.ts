/**
 * The expense lines APPROVE posts for a bill, as committed spend reads them: one module shared by `remainingCommitted` (line
 * billing, and the callers that import it from there) and `remainingHeaderBilled` (what a bill's lines already attribute), so
 * neither imports the other.
 */
import type { DbRow } from '@/lib/neon';
import { buildExpenseLines } from '../ap/supplierInvoiceExpenseLines';
import { mapInvoiceRow } from '../ap/supplierInvoiceWorkflowRow';
import type { SupplierInvoiceItem } from '../../types/ap.types';

/** The fields buildExpenseLines reads; `description` carries the line id so each posted line maps back to its item. */
function itemOf(r: DbRow): SupplierInvoiceItem {
  return {
    id: String(r.id), supplierInvoiceId: String(r.supplier_invoice_id), description: String(r.id),
    quantity: Number(r.quantity), unitPrice: Number(r.unit_price), taxRate: Number(r.tax_rate), taxAmount: Number(r.tax_amount),
    lineTotal: Number(r.line_total), glAccountId: r.gl_account_id ? String(r.gl_account_id) : undefined,
    createdAt: String(r.created_at),
    ...(r.cc1_id ? { cc1Id: String(r.cc1_id) } : {}), ...(r.cc2_id ? { cc2Id: String(r.cc2_id) } : {}), ...(r.bu_id ? { buId: String(r.bu_id) } : {}),
  };
}

/** The account `buildExpenseLines` is given: a posted line naming it named no account of its own. */
export const NO_ACCOUNT = 'unused';

/**
 * The expense lines APPROVE posts for one bill (`buildExpenseLines` over its row and its lines in
 * `SUPPLIER_INVOICE_LINE_ORDER_BY` order): `description` is the stored line's id, `debit` its posted ex-VAT amount.
 * A line folded away or dropped as R0 does not appear. One definition for committed, the PO approval and the
 * PO-to-bill links (`ap/purchaseOrderBillLinkPlan`), so a link's amount is the figure the ledger holds.
 */
export function postedExpenseLines(bill: DbRow, billItems: DbRow[]) {
  return buildExpenseLines({ ...mapInvoiceRow(bill), items: billItems.map(itemOf) }, NO_ACCOUNT);
}

