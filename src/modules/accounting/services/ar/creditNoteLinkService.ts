/**
 * Credit-note link validation — tenant + counterparty checks for the optional
 * invoice a credit note is raised against.
 *
 * `createCreditNote` writes `client_id` / `supplier_id` / `customer_invoice_id`
 * / `supplier_invoice_id` as plain foreign keys: none of them carries a
 * composite `(id, company_id)` constraint, and the service never re-reads them.
 * That is harmless while the only caller is a UI page whose pickers are already
 * company-scoped, but it is the whole fence once an agent can pass arbitrary
 * UUIDs over MCP.
 *
 * The counterparty check matters as much as the tenant one. `approveCreditNote`
 * AUTO-APPLIES a linked note — it adds the note's total to the linked invoice's
 * `amount_paid` — so a note naming customer A but linked to customer B's
 * invoice silently pays down B's debt with A's credit, and nothing downstream
 * ever flags it.
 */

import { sql } from '@/lib/neon';
import type { CreditNoteCreateInput } from '../../types/ar.types';

type Row = Record<string, unknown>;

/**
 * Returns an agent-readable refusal, or null when every supplied link is valid.
 *
 * Deliberately message-shaped rather than boolean: the caller needs to tell an
 * unknown customer from a mismatched invoice to say anything useful, and every
 * message here is safe to hand back because it only ever names ids the caller
 * already supplied.
 */
export async function validateCreditNoteLinks(
  companyId: string,
  input: Pick<
    CreditNoteCreateInput,
    'type' | 'clientId' | 'customerInvoiceId' | 'supplierId' | 'supplierInvoiceId'
  >,
): Promise<string | null> {
  if (input.type === 'customer') {
    return validateCustomerLinks(companyId, input.clientId, input.customerInvoiceId);
  }
  return validateSupplierLinks(companyId, input.supplierId, input.supplierInvoiceId);
}

/**
 * A credit note may only be linked to an invoice that actually owes something.
 *
 * A DRAFT invoice has posted nothing to the ledger, so crediting it produces a
 * receivable reduction against a document the books have never seen — and
 * approve then bumps its amount_paid, so the draft can be issued later already
 * looking part-paid. A cancelled or written-off invoice is settled business
 * that a new credit must not silently reopen.
 */
function invoiceStatusRefusal(status: string): string | null {
  const CREDITABLE = ['approved', 'sent', 'overdue', 'partially_paid', 'paid'];
  if (!CREDITABLE.includes(status)) {
    return `The linked invoice is '${status}'; only an issued invoice (${CREDITABLE.join(', ')}) can be credited.`;
  }
  return null;
}

async function validateCustomerLinks(
  companyId: string,
  clientId?: string,
  customerInvoiceId?: string,
): Promise<string | null> {
  if (!clientId) return 'client_id is required for a customer credit note';

  const customer = (await sql`
    SELECT 1 FROM customers
    WHERE id = ${clientId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
    LIMIT 1
  `) as Row[];
  if (customer.length === 0) return 'Not found';

  if (!customerInvoiceId) return null;

  // COALESCE(client_id, customer_id): both columns exist on customer_invoices
  // and older rows populate only the second (see CLAUDE.md).
  const invoice = (await sql`
    SELECT COALESCE(client_id, customer_id) AS owner_id, status
    FROM customer_invoices
    WHERE id = ${customerInvoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (invoice.length === 0) return 'Not found';
  if (String(invoice[0]!.owner_id) !== clientId) {
    return 'customer_invoice_id belongs to a different customer than client_id';
  }
  return invoiceStatusRefusal(String(invoice[0]!.status));
}

async function validateSupplierLinks(
  companyId: string,
  supplierId?: string,
  supplierInvoiceId?: string,
): Promise<string | null> {
  if (!supplierId) return 'supplier_id is required for a supplier credit note';

  const supplier = (await sql`
    SELECT 1 FROM suppliers
    WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
    LIMIT 1
  `) as Row[];
  if (supplier.length === 0) return 'Not found';

  if (!supplierInvoiceId) return null;

  const invoice = (await sql`
    SELECT supplier_id, status FROM supplier_invoices
    WHERE id = ${supplierInvoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (invoice.length === 0) return 'Not found';
  if (String(invoice[0]!.supplier_id) !== supplierId) {
    return 'supplier_invoice_id belongs to a different supplier than supplier_id';
  }
  return invoiceStatusRefusal(String(invoice[0]!.status));
}
