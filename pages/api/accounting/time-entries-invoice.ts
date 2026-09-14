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
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { insertWithReservedNumber } from '@/modules/accounting/services/core/documentNumberRetry';
import { lockTimeEntries, TimeEntriesNotClaimedError } from '@/modules/accounting/services/practice/timeEntryLock';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

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

    // 2. Load time entries — must belong to company, be billable, not yet
    // invoiced. The row lock is taken FIRST: without it this read was a
    // check-then-act and two concurrent POSTs over the same ids both minted a
    // full invoice, billing the client twice (see timeEntryLock).
    await lockTimeEntries(companyId, timeEntryIds.map(String));
    const entries = (await sql`
      SELECT id, task_description, hours, rate, entry_date, project_name
      FROM time_entries
      WHERE id = ANY(${timeEntryIds}::UUID[])
        AND company_id = ${companyId}::UUID
        AND invoiced = false
        AND billed_at IS NULL
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

    // 4. Reserve the number from the company sequence. What this replaced was a
    // fourth MAX(invoice_number)+1 generator inside the sequence's own uniqueness
    // domain — it never advanced company_document_numbers — retrying on a message
    // containing "unique" with no savepoint, so a real 23505 left the request
    // transaction aborted and every later attempt failed 25P02 instead.
    const { invoiceId, invoiceNumber } = await insertWithReservedNumber(
      companyId, 'customer_invoice', 'te_inv_', 'uq_customer_invoices_company_number',
      async (number) => {
        const invRows = (await sql`
          INSERT INTO customer_invoices (
            company_id, invoice_number, customer_id, client_id,
            subtotal, tax_rate, tax_amount, total_amount,
            invoice_date, status, created_by,
            currency_code, exchange_rate, functional_total
          ) VALUES (
            ${companyId}, ${number}, ${customerId}::UUID, ${customerId}::UUID,
            ${subtotal}, ${rate}, ${taxAmount}, ${totalAmount},
            ${invDate!}, 'draft', ${userId},
            'ZAR', 1.0, ${totalAmount}
          ) RETURNING id
        `) as Row[];
        return { invoiceId: String(invRows[0]!.id), invoiceNumber: number };
      },
    );

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

    // 6. Claim the entries with a PREDICATED update, and check the row count.
    // The old UPDATE matched on id + company only and its count was discarded,
    // so a loser that had already been beaten to these entries still reported
    // success and left a second billed invoice behind.
    //
    // `billed_at IS NULL` is here and in the read above because this table has
    // TWO billing subsystems on it. The practice WIP path marks an entry
    // status='billed' + billed_at, leaving `invoiced` false; this route read
    // only `invoiced = false`, so every entry the practice path had already
    // invoiced was still offered here and billed to the client a second time —
    // no concurrency required. The reverse hole does not exist: this route sets
    // status='invoiced', which the WIP path's status='approved' already excludes.
    const claimed = (await sql`
      UPDATE time_entries
      SET invoiced = true, invoice_id = ${invoiceId}::UUID, status = 'invoiced', updated_at = NOW()
      WHERE id = ANY(${entries.map(e => String(e.id))}::UUID[])
        AND company_id = ${companyId}::UUID
        AND invoiced = false
        AND billed_at IS NULL
      RETURNING id
    `) as Row[];
    if (claimed.length !== entries.length) {
      throw new TimeEntriesNotClaimedError(entries.length, claimed.length);
    }

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
    // 503 with Retry-After for contention, 500 for everything else. Both are
    // >= 500, so withAuth ROLLBACKs either way and no partial invoice survives.
    if (respondIfLockTimeout(res, err)) return;
    return apiResponse.internalError(res, err, 'Failed to create invoice from time entries');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
