/**
 * Sage Customer Invoice Importer
 * Moves sage_customer_invoices → customer_invoices + customer_invoice_items
 * Matches Sage's approach: invoices are standalone AR documents,
 * no separate GL journal entries are created per invoice.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { MigrationRun } from './sageMigrationService';
import { startRun, completeRun, failRun } from './sageMigrationService';
type Row = any;


/**
 * Import sage_customer_invoices into customer_invoices with line items
 */
export async function importCustomerInvoices(companyId: string, userId: string): Promise<MigrationRun> {
  const runId = await startRun('customer_invoice_import', userId);

  try {
    const sageInvoices = (await sql`
      SELECT id, sage_invoice_id, sage_customer_id, client_id,
        invoice_number, invoice_date, due_date,
        subtotal, tax_amount, total_amount, outstanding_amount,
        status, raw_data
      FROM sage_customer_invoices
      WHERE migration_status = 'pending'
      ORDER BY invoice_date
    `) as Row[];

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const inv of sageInvoices) {
      try {
        const totalAmount = Number(inv.total_amount || 0);
        if (totalAmount === 0) { skipped++; continue; }

        const clientId = inv.client_id;
        if (!clientId) {
          await sql`
            UPDATE sage_customer_invoices SET migration_status = 'failed'
            WHERE id = ${inv.id}
          `;
          failed++;
          continue;
        }

        const subtotal = Number(inv.subtotal || 0) || totalAmount / 1.15;
        const taxAmount = Number(inv.tax_amount || 0) || totalAmount - subtotal;
        const taxRate = subtotal > 0
          ? Math.round((taxAmount / subtotal) * 100 * 100) / 100
          : 15;
        const isPaid = inv.status === 'paid'
          || Number(inv.outstanding_amount || 0) === 0;

        // Extract reference from raw_data
        const rawData = parseRawData(inv.raw_data);
        const reference = rawData?.Reference || inv.invoice_number || null;

        const newInv = (await sql`
          INSERT INTO customer_invoices (
            invoice_number, client_id, invoice_date, due_date,
            billing_period_start, billing_period_end,
            subtotal, tax_rate, tax_amount, total_amount,
            amount_paid, status, sage_invoice_id, reference, created_by
          ) VALUES (
            ${inv.invoice_number || `SAGE-${inv.sage_invoice_id}`},
            ${clientId}::UUID,
            ${inv.invoice_date}, ${inv.due_date || inv.invoice_date},
            ${inv.invoice_date}, ${inv.due_date || inv.invoice_date},
            ${subtotal.toFixed(2)}, ${taxRate}, ${taxAmount.toFixed(2)},
            ${totalAmount},
            ${isPaid ? totalAmount : 0},
            ${isPaid ? 'paid' : 'approved'},
            ${inv.sage_invoice_id},
            ${reference},
            ${userId}
          ) RETURNING id
        `) as Row[];

        const newInvoiceId = String(newInv[0].id);

        // Insert line items from raw_data
        const lines = rawData?.Lines;
        if (lines && Array.isArray(lines) && lines.length > 0) {
          for (const line of lines) {
            const qty = Number(line.Quantity || 1);
            const price = Number(line.UnitPriceExclusive || 0);
            const lineTax = Number(line.Tax || 0);
            const lineTotal = Number(line.Exclusive || line.Total || price * qty);

            await sql`
              INSERT INTO customer_invoice_items (
                invoice_id, description, unit_price, quantity,
                tax_amount, line_total, income_type
              ) VALUES (
                ${newInvoiceId}::UUID,
                ${line.Description || 'Line item'},
                ${price}, ${qty}, ${lineTax}, ${lineTotal}, 'other'
              )
            `;
          }
        }

        await sql`
          UPDATE sage_customer_invoices
          SET migration_status = 'imported',
              gl_customer_invoice_id = ${newInvoiceId}::UUID
          WHERE id = ${inv.id}
        `;

        succeeded++;
      } catch (err) {
        log.error('Failed to import customer invoice',
          { invoiceId: inv.id, error: err }, 'accounting');
        await sql`
          UPDATE sage_customer_invoices SET migration_status = 'failed'
          WHERE id = ${inv.id}
        `;
        failed++;
      }
    }

    return await completeRun(runId, sageInvoices.length, succeeded, failed, skipped);
  } catch (err) {
    await failRun(runId, err);
    throw err;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRawData(rawData: unknown): any {
  if (!rawData) return null;
  if (typeof rawData === 'string') {
    try { return JSON.parse(rawData); } catch { return null; }
  }
  return rawData;
}
