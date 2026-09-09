/**
 * Quote Convert Service
 * Convert-to-sales-order and convert-to-invoice — split from quoteService.ts.
 *
 * ATOMICITY: the multi-statement conversions below are NOT individually
 * transacted on purpose. Their only caller is an API route under `withAuth`,
 * which runs the whole request inside one BEGIN/COMMIT on the ALS-bound
 * connection (see src/lib/auth/withAuth.ts), so a failure anywhere rolls back
 * every statement — including the document-number increment. Do NOT wrap
 * these in `withTransaction`: it takes a fresh pool connection without the
 * request's RLS GUCs and commits independently of the request tx. Any future
 * non-request caller (cron/script) must provide its own transaction.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { insertWithReservedNumber } from '../core/documentNumberRetry';
import { getQuote } from './quoteService';
import type { Quote } from './quoteService';

type Row = DbRow;

/**
 * The only states a quote may be converted to a sales order FROM.
 *
 * An allow-list, not a deny-list: `customer_quotes_status_check` permits
 * draft, sent, accepted, rejected, declined, expired, converted and
 * converted_to_order, so a "not already converted" guard still let a REJECTED
 * or EXPIRED quote through — and let a quote already turned into an invoice
 * (`converted`, holding `converted_invoice_id`) be turned into an order too,
 * silently rewriting its status so the invoiced state was no longer visible.
 * That order could then be invoiced again: the same quote billed twice.
 */
const CONVERTIBLE_TO_ORDER = ['accepted', 'sent'];

export class QuoteNotConvertibleError extends Error {
  constructor(
    readonly quoteStatus: string,
    readonly existingOrderId: string | null,
  ) {
    super(`A quote with status '${quoteStatus}' cannot be converted to a sales order`);
    this.name = 'QuoteNotConvertibleError';
  }
}

/**
 * The invoice-side twin of QuoteNotConvertibleError.
 *
 * Separate class rather than a shared one with a `target` field: the two arms
 * hand back different ids (`converted_order_id` vs `converted_invoice_id`) and
 * their routes answer with different payload keys.
 */
export class QuoteNotInvoiceableError extends Error {
  constructor(
    readonly quoteStatus: string,
    readonly existingInvoiceId: string | null,
  ) {
    super(`A quote with status '${quoteStatus}' cannot be converted to an invoice`);
    this.name = 'QuoteNotInvoiceableError';
  }
}

export async function convertToSalesOrder(
  companyId: string,
  id: string,
  userId?: string,
): Promise<{ quote: Quote; salesOrderId: string } | null> {
  const quote = await getQuote(companyId, id);
  if (!quote) return null;

  // CLAIM THE QUOTE BEFORE ANYTHING IS MINTED. The existence check above is a
  // check-then-act: a double-click or a client retry used to reserve a second
  // SO number, insert a full duplicate order with all its lines, and overwrite
  // converted_order_id so the quote pointed at only the second. The
  // status-predicated UPDATE is the guard — the first caller moves the quote
  // out of a convertible status and every later one sees zero rows and stops
  // here, before the sequence is touched and before any status is rewritten.
  const claimed = (await sql`
    UPDATE customer_quotes
    SET status = 'converted_to_order', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      AND status = ANY(${CONVERTIBLE_TO_ORDER}::TEXT[])
    RETURNING id
  `) as Row[];
  if (claimed.length === 0) {
    // Re-read rather than trusting the row read before the UPDATE: the loser of
    // a double-click needs the winner's order id, which did not exist yet then.
    const [current] = (await sql`
      SELECT status, converted_order_id FROM customer_quotes
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    throw new QuoteNotConvertibleError(
      String(current?.status ?? quote.status),
      current?.converted_order_id ? String(current.converted_order_id) : null,
    );
  }

  const numRows = (await sql`
    INSERT INTO company_document_numbers (company_id, document_type, prefix, next_number)
    VALUES (${companyId}::UUID, 'sales_order', 'SO-', 1)
    ON CONFLICT (company_id, document_type)
    DO UPDATE SET next_number = company_document_numbers.next_number + 1
    RETURNING next_number - 1 AS current_number, prefix
  `) as Row[];
  const num = Number(numRows[0]!.current_number);
  const prefix = String(numRows[0]!.prefix || 'SO-');
  const orderNumber = `${prefix}${String(num).padStart(5, '0')}`;

  const soRows = (await sql`
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
  const salesOrderId = String(soRows[0]!.id);

  for (let i = 0; i < (quote.lines || []).length; i++) {
    const line = quote.lines![i]!;
    await sql`
      INSERT INTO customer_sales_order_items (
        sales_order_id, line_number, description, quantity, unit_price, tax_rate, line_total
      ) VALUES (
        ${salesOrderId}::UUID, ${i + 1}, ${line.description}, ${line.quantity},
        ${line.unitPrice}, ${line.taxRate}, ${line.lineTotal}
      )
    `;
  }

  await sql`
    UPDATE customer_quotes
    SET converted_order_id = ${salesOrderId}::UUID, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Quote converted to sales order', { quoteId: id, salesOrderId });
  return { quote: (await getQuote(companyId, id))!, salesOrderId };
}

export async function convertToInvoice(
  companyId: string,
  id: string,
  userId?: string,
): Promise<{ quote: Quote; invoiceId: string } | null> {
  const quote = await getQuote(companyId, id);
  if (!quote) return null;

  // CLAIM THE QUOTE BEFORE ANYTHING IS MINTED — the same guard convertToSalesOrder
  // takes above, for the same reason. `quote.status !== 'accepted'` was a
  // check-then-act: two concurrent calls (two tabs, a client retry, or the API
  // called directly) both read 'accepted', both reserved an invoice number and
  // both inserted a full customer invoice with the quote's lines. The counter
  // row lock serialises the numbering but does not stop the second mint — the
  // loser simply waits for the winner to commit and then bills the customer a
  // second time, with converted_invoice_id pointing at only one of the two, so
  // the duplicate is invisible from the quote screen. The status-predicated
  // UPDATE is the guard: the first caller moves the quote out of 'accepted' and
  // every later one sees zero rows and stops here, before the sequence is
  // touched and before any line is written.
  const claimed = (await sql`
    UPDATE customer_quotes
    SET status = 'converted', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      AND status = 'accepted'
    RETURNING id
  `) as Row[];
  if (claimed.length === 0) {
    // Re-read rather than trusting the row read before the UPDATE: the loser of
    // a double-click needs the winner's invoice id, which did not exist then.
    const [current] = (await sql`
      SELECT status, converted_invoice_id FROM customer_quotes
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    throw new QuoteNotInvoiceableError(
      String(current?.status ?? quote.status),
      current?.converted_invoice_id ? String(current.converted_invoice_id) : null,
    );
  }

  // Use the SAME sequence as customer-invoices-create ('customer_invoice').
  // The old inline counter used a SEPARATE document_type ('invoice', 'INV-'
  // 5-pad) — two generators for one uniqueness domain — and its fresh counter
  // walked straight into historical INV-xxxxx rows (uq violation, found live
  // 2026-07-05). Same savepoint-isolated retry as the create path: a clash
  // with a legacy number must not poison the request transaction.
  const invoiceId = await insertWithReservedNumber(
    companyId, 'customer_invoice', 'quote_conv_inv_', 'uq_customer_invoices_company_number', async (invoiceNumber) => {
      const invRows = (await sql`
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
      return String(invRows[0]!.id);
    });

  for (const line of quote.lines || []) {
    await sql`
      INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, tax_rate, amount, gl_account_id)
      VALUES (${invoiceId}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice}, ${line.taxRate}, ${line.lineTotal}, ${line.accountId})
    `;
  }

  // Status was already set by the claim above; only the link is left to write.
  await sql`UPDATE customer_quotes SET converted_invoice_id = ${invoiceId}::UUID, updated_at = NOW() WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;

  log.info('Quote converted to invoice', { quoteId: id, invoiceId });
  return { quote: (await getQuote(companyId, id))!, invoiceId };
}

