/**
 * Quote Convert Service
 * Convert-to-sales-order and convert-to-invoice — split from quoteService.ts.
 */

import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getQuote } from './quoteService';
import { sql } from '@/lib/neon';
import type { Quote } from './quoteService';

type Row = DbRow;

export async function convertToSalesOrder(
  companyId: string,
  id: string,
  userId?: string,
): Promise<{ quote: Quote; salesOrderId: string } | null> {
  const quote = await getQuote(companyId, id);
  if (!quote) return null;

  const salesOrderId = await withTransaction(async (tx) => {
    const numRows = (await tx`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number)
      VALUES (${companyId}::UUID, 'sales_order', 'SO-', 1)
      ON CONFLICT (company_id, document_type)
      DO UPDATE SET next_number = company_document_numbers.next_number + 1
      RETURNING next_number - 1 AS current_number, prefix
    `) as Row[];
    const num = Number(numRows[0]!.current_number);
    const prefix = String(numRows[0]!.prefix || 'SO-');
    const orderNumber = `${prefix}${String(num).padStart(5, '0')}`;

    const soRows = (await tx`
      INSERT INTO customer_sales_orders (
        company_id, order_number, customer_id, order_date, delivery_date,
        reference, subtotal, tax_amount, total_amount, notes, created_by
      ) VALUES (
        ${companyId}::UUID, ${orderNumber}, ${quote.clientId || null},
        ${quote.quoteDate}, ${quote.expiryDate || null},
        ${quote.quoteNumber}, ${quote.subtotal}, ${quote.taxAmount}, ${quote.total},
        ${quote.notes || null}, ${userId || null}
      ) RETURNING id
    `) as Row[];
    const newSoId = String(soRows[0]!.id);

    for (let i = 0; i < (quote.lines || []).length; i++) {
      const line = quote.lines![i]!;
      await tx`
        INSERT INTO customer_sales_order_items (
          sales_order_id, line_number, description, quantity, unit_price, tax_rate, line_total
        ) VALUES (
          ${newSoId}::UUID, ${i + 1}, ${line.description}, ${line.quantity},
          ${line.unitPrice}, ${line.taxRate}, ${line.lineTotal}
        )
      `;
    }

    await tx`
      UPDATE customer_quotes
      SET status = 'converted_to_order', converted_order_id = ${newSoId}::UUID, updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `;

    return newSoId;
  });

  log.info('Quote converted to sales order', { quoteId: id, salesOrderId });
  return { quote: (await getQuote(companyId, id))!, salesOrderId };
}

export async function convertToInvoice(
  companyId: string,
  id: string,
  userId?: string,
): Promise<{ quote: Quote; invoiceId: string } | null> {
  const quote = await getQuote(companyId, id);
  if (!quote || quote.status !== 'accepted') return null;

  const invoiceId = await withTransaction(async (tx) => {
    // BL-55: generate invoice_number via company_document_numbers (atomic, unique)
    const numRows = (await tx`
      INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number)
      VALUES (${companyId}::UUID, 'invoice', 'INV-', 1)
      ON CONFLICT (company_id, document_type)
      DO UPDATE SET next_number = company_document_numbers.next_number + 1
      RETURNING next_number - 1 AS current_number, prefix
    `) as Row[];
    const invNum = Number(numRows[0]!.current_number);
    const invPrefix = String(numRows[0]!.prefix || 'INV-');
    const invoiceNumber = `${invPrefix}${String(invNum).padStart(5, '0')}`;

    // BL-55: use total_amount (correct column name); populate invoice_number and customer_id
    const invRows = (await tx`
      INSERT INTO customer_invoices (
        company_id, invoice_number, client_id, customer_id,
        invoice_date, due_date, subtotal, tax_amount, total_amount,
        notes, status, created_by
      ) VALUES (
        ${companyId}::UUID, ${invoiceNumber}, ${quote.clientId || null}, ${quote.clientId || null},
        ${quote.quoteDate}, ${quote.expiryDate || quote.quoteDate},
        ${quote.subtotal}, ${quote.taxAmount}, ${quote.total},
        ${'Converted from ' + quote.quoteNumber}, 'draft', ${userId || null}
      ) RETURNING id
    `) as Row[];
    const newInvoiceId = String(invRows[0]!.id);

    for (const line of quote.lines || []) {
      await tx`
        INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, tax_rate, line_total, account_id)
        VALUES (${newInvoiceId}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.taxRate}, ${line.lineTotal}, ${line.accountId})
      `;
    }

    await tx`UPDATE customer_quotes SET status = 'converted', converted_invoice_id = ${newInvoiceId}::UUID, updated_at = NOW() WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
    return newInvoiceId;
  });

  log.info('Quote converted to invoice', { quoteId: id, invoiceId });
  return { quote: (await getQuote(companyId, id))!, invoiceId };
}

// Re-export sql to avoid unused import — quoteConvertService uses sql indirectly via withTransaction
void sql;
