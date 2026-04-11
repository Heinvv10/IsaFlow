/**
 * Time Entries → Invoice API
 * POST — convert selected time entries to a customer invoice
 *   Body: { timeEntryIds: string[], customerId: string, invoiceDate?: string, taxRate?: number }
 *   Creates a draft customer_invoice with line items from the time entries.
 *   Marks time_entries as invoiced = true and sets invoice_id.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { timeEntryIds, customerId, invoiceDate, taxRate } = req.body as {
    timeEntryIds?: unknown;
    customerId?: unknown;
    invoiceDate?: unknown;
    taxRate?: unknown;
  };

  if (!Array.isArray(timeEntryIds) || timeEntryIds.length === 0) {
    return apiResponse.badRequest(res, 'timeEntryIds[] is required and must be non-empty');
  }
  if (!customerId || typeof customerId !== 'string') {
    return apiResponse.badRequest(res, 'customerId is required');
  }

  const userId = String(req.user.id);
  const invDate = typeof invoiceDate === 'string' && invoiceDate ? invoiceDate : new Date().toISOString().split('T')[0];
  const rate = typeof taxRate === 'number' ? taxRate : 15;

  try {
    // 1. Verify customer belongs to company
    const custRows = (await sql`
      SELECT id, name FROM customers
      WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
    `) as Row[];
    if (!custRows[0]) return apiResponse.badRequest(res, 'Customer not found in this company');

    // 2. Load time entries — must belong to company, be billable, not yet invoiced
    const entries = (await sql`
      SELECT id, task_description, hours, rate, entry_date, project_name
      FROM time_entries
      WHERE id = ANY(${timeEntryIds}::UUID[])
        AND company_id = ${companyId}::UUID
        AND invoiced = false
        AND billable = true
    `) as Row[];

    if (entries.length === 0) {
      return apiResponse.badRequest(res, 'No eligible time entries found (must be billable and not yet invoiced)');
    }

    // 3. Calculate totals
    let subtotal = 0;
    for (const e of entries) {
      const hours = Number(e.hours ?? 0);
      const entryRate = Number(e.rate ?? 0);
      subtotal += hours * entryRate;
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const taxAmount = Math.round(subtotal * (rate / 100) * 100) / 100;
    const totalAmount = subtotal + taxAmount;

    // 4. Generate invoice number (retry on conflict)
    let invoiceId = '';
    let invoiceNumber = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const maxRows = (await sql`
        SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
        FROM customer_invoices WHERE company_id = ${companyId} AND invoice_number ~ '^INV-[0-9]+$'
      `) as Row[];
      const base = Number(maxRows[0]?.['max_num'] ?? 0) + 1 + attempt;
      invoiceNumber = `INV-${String(base).padStart(5, '0')}`;

      try {
        const invRows = (await sql`
          INSERT INTO customer_invoices (
            company_id, invoice_number, customer_id, client_id,
            subtotal, tax_rate, tax_amount, total_amount,
            invoice_date, status, created_by,
            currency_code, exchange_rate, functional_total
          ) VALUES (
            ${companyId}, ${invoiceNumber}, ${customerId}::UUID, ${customerId}::UUID,
            ${subtotal}, ${rate}, ${taxAmount}, ${totalAmount},
            ${invDate!}, 'draft', ${userId},
            'ZAR', 1.0, ${totalAmount}
          ) RETURNING id
        `) as Row[];
        invoiceId = String(invRows[0]!.id);
        break;
      } catch (insertErr) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes('unique') && attempt < 4) continue;
        throw insertErr;
      }
    }

    // 5. Insert line items for each time entry
    for (const e of entries) {
      const hours = Number(e.hours ?? 0);
      const entryRate = Number(e.rate ?? 0);
      const lineAmount = Math.round(hours * entryRate * 100) / 100;
      const dateStr = String(e.entry_date ?? '').split('T')[0] ?? invDate;
      const projectNote = e.project_name ? ` [${String(e.project_name)}]` : '';
      const description = `${dateStr}${projectNote} — ${String(e.task_description)} (${hours}h @ R${entryRate}/h)`;

      await sql`
        INSERT INTO customer_invoice_items (
          invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
        ) VALUES (
          ${invoiceId}::UUID, ${description}, ${entryRate},
          ${hours}, ${lineAmount}, ${rate}, 'ZAR'
        )
      `;
    }

    // 6. Mark time entries as invoiced
    await sql`
      UPDATE time_entries
      SET invoiced = true, invoice_id = ${invoiceId}::UUID, status = 'invoiced', updated_at = NOW()
      WHERE id = ANY(${entries.map(e => String(e.id))}::UUID[])
        AND company_id = ${companyId}::UUID
    `;

    log.info('Time entries converted to invoice', {
      invoiceNumber, invoiceId, count: entries.length, totalAmount,
    }, 'accounting');

    return apiResponse.created(res, {
      invoiceId,
      invoiceNumber,
      lineCount: entries.length,
      subtotal,
      taxAmount,
      totalAmount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('time-entries-invoice failed', { error: msg }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to create invoice from time entries');
  }
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
