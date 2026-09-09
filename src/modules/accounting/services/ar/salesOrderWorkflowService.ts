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

export async function convertSalesOrderToInvoice(
  companyId: string,
  salesOrderId: string,
  userId: string
): Promise<{ invoiceId: string }> {
  const order = await getSalesOrder(companyId, salesOrderId);
  if (!order) throw new Error('Sales order not found');
  if (order.status !== 'confirmed') throw new Error('Sales order must be confirmed before invoicing');

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
    companyId, 'customer_invoice', 'so_conv_inv_', async (invoiceNumber) => {
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

  await sql`
    UPDATE customer_sales_orders
    SET status = 'invoiced', invoice_id = ${invoiceId}::UUID, invoiced_at = NOW(), updated_at = NOW()
    WHERE id = ${salesOrderId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Sales order converted to invoice', { salesOrderId, invoiceId });
  return { invoiceId };
}
