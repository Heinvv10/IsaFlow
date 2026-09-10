/**
 * Sales Order Workflow Service
 * Confirm and convert-to-invoice operations for customer sales orders.
 * CRUD lives in salesOrderService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSalesOrder } from './salesOrderService';
import { insertWithReservedNumber } from '../core/documentNumberRetry';
import { claimUnderLockTimeout } from '../core/documentClaimLock';

type Row = DbRow;

export async function confirmSalesOrder(
  companyId: string,
  salesOrderId: string,
  userId: string
): Promise<void> {
  const rows = (await sql`
    UPDATE customer_sales_orders
    SET status = 'confirmed', confirmed_by = ${userId}::UUID, confirmed_at = NOW(), updated_at = NOW()
    WHERE id = ${salesOrderId}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING id
  `) as Row[];
  if (rows.length === 0) {
    throw new Error('Order not found or already confirmed');
  }
  log.info('Sales order confirmed', { salesOrderId, userId });
}

/**
 * Raised when the order's status forbids invoicing it — including the loser of
 * two concurrent invoice attempts, which carries the winner's invoice id.
 *
 * Raised BEFORE anything is minted, so the route may answer it with a 4xx:
 * `withAuth` COMMITs the request transaction on a 4xx and only ROLLBACKs on a
 * 5xx, so a 4xx after a write persists that write.
 */
export class SalesOrderNotInvoiceableError extends Error {
  constructor(
    readonly orderStatus: string,
    readonly existingInvoiceId: string | null,
  ) {
    super(`A sales order with status '${orderStatus}' cannot be invoiced`);
    this.name = 'SalesOrderNotInvoiceableError';
  }
}

export async function convertSalesOrderToInvoice(
  companyId: string,
  salesOrderId: string,
  userId: string
): Promise<{ invoiceId: string }> {
  const order = await getSalesOrder(companyId, salesOrderId);
  if (!order) throw new Error('Sales order not found');

  // CLAIM THE ORDER BEFORE ANYTHING IS MINTED. Reading the status and then
  // minting is a check-then-act — the same defect quoteConvertService carried
  // on both its arms. Two concurrent 'invoice' actions on one confirmed order
  // both read 'confirmed', both reserved an invoice number and both inserted a
  // full customer invoice with the order's lines: the customer billed twice,
  // AR and output VAT overstated by the order total, with `invoice_id` on the
  // order pointing at only the second so the duplicate is invisible from the
  // order screen. The status-predicated UPDATE is the guard; the loser sees
  // zero rows and stops here, before the sequence is touched.
  const claimed = await claimUnderLockTimeout('sales order', async () => (await sql`
    UPDATE customer_sales_orders
    SET status = 'invoiced', invoiced_at = NOW(), updated_at = NOW()
    WHERE id = ${salesOrderId}::UUID AND company_id = ${companyId}::UUID
      AND status = 'confirmed'
    RETURNING id
  `) as Row[]);
  if (claimed.length === 0) {
    // Re-read rather than trusting the row read before the UPDATE: the loser
    // needs the winner's invoice id, which did not exist then.
    const [current] = (await sql`
      SELECT status, invoice_id FROM customer_sales_orders
      WHERE id = ${salesOrderId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    throw new SalesOrderNotInvoiceableError(
      String(current?.status ?? order.status),
      current?.invoice_id ? String(current.invoice_id) : null,
    );
  }

  // Mint from the COMPANY SEQUENCE, not from MAX(invoice_number)+1. The old
  // read was a second generator for one uniqueness domain
  // (uq_customer_invoices_company_number): it never advanced
  // company_document_numbers, so the counter shown in company settings stayed
  // behind the live numbers, and it padded to 5 where the sequence pads to the
  // configured width — two formats for one document type. Same savepointed
  // 23505 retry as quoteConvertService.convertToInvoice, so a clash with a
  // legacy number costs one more number instead of poisoning the request
  // transaction.
  const invoiceId = await insertWithReservedNumber(
    companyId, 'customer_invoice', 'so_conv_inv_', 'uq_customer_invoices_company_number', async (invoiceNumber) => {
      const invRows = (await sql`
        INSERT INTO customer_invoices (
          company_id, invoice_number, customer_id, client_id,
          invoice_date, due_date,
          subtotal, tax_amount, total_amount,
          notes, status, created_by
        ) VALUES (
          ${companyId}, ${invoiceNumber},
          ${order.customerId || null}, ${order.customerId || null},
          ${order.orderDate}, ${order.deliveryDate || order.orderDate},
          ${order.subtotal}, ${order.taxAmount}, ${order.totalAmount},
          ${'Converted from ' + order.orderNumber}, 'draft', ${userId}
        ) RETURNING id
      `) as Row[];
      return String(invRows[0]!.id);
    });

  for (const item of order.items || []) {
    await sql`
      INSERT INTO customer_invoice_items (
        invoice_id, description, quantity, unit_price, tax_rate, amount, currency_code
      ) VALUES (
        ${invoiceId}::UUID, ${item.description}, ${item.quantity},
        ${item.unitPrice}, ${item.taxRate}, ${item.lineTotal}, 'ZAR'
      )
    `;
  }

  // Status and invoiced_at were set by the claim above; only the link is left.
  await sql`
    UPDATE customer_sales_orders
    SET invoice_id = ${invoiceId}::UUID, updated_at = NOW()
    WHERE id = ${salesOrderId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Sales order converted to invoice', { salesOrderId, invoiceId });
  return { invoiceId };
}
