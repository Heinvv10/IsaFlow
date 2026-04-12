/**
 * Sales Order Workflow Service
 * Confirm and convert-to-invoice operations for customer sales orders.
 * CRUD lives in salesOrderService.ts.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSalesOrder } from './salesOrderService';

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

  const invoiceId = await withTransaction(async (tx) => {
    const maxRows = (await tx`
      SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
      FROM customer_invoices WHERE company_id = ${companyId} AND invoice_number ~ '^INV-[0-9]+$'
    `) as Row[];
    const nextNum = Number(maxRows[0]?.max_num ?? 0) + 1;
    const invoiceNumber = `INV-${String(nextNum).padStart(5, '0')}`;

    const invRows = (await tx`
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
    const newInvoiceId = String(invRows[0]!.id);

    for (const item of order.items || []) {
      await tx`
        INSERT INTO customer_invoice_items (
          invoice_id, description, quantity, unit_price, tax_rate, amount, currency_code
        ) VALUES (
          ${newInvoiceId}::UUID, ${item.description}, ${item.quantity},
          ${item.unitPrice}, ${item.taxRate}, ${item.lineTotal}, 'ZAR'
        )
      `;
    }

    await tx`
      UPDATE customer_sales_orders
      SET status = 'invoiced', invoice_id = ${newInvoiceId}::UUID, invoiced_at = NOW(), updated_at = NOW()
      WHERE id = ${salesOrderId}::UUID AND company_id = ${companyId}::UUID
    `;

    return newInvoiceId;
  });

  log.info('Sales order converted to invoice', { salesOrderId, invoiceId });
  return { invoiceId };
}
