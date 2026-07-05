/**
 * Customer Invoice Detail API
 * GET  ?id=UUID — single invoice with line items
 * PUT  { id, ...fields } — update draft invoice
 * POST { id, action } — status actions (approve, send, cancel)
 */

import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import { UUID, ISODate } from '@/lib/schemas/common';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentService';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';
type Row = Record<string, unknown>;

const GetQuerySchema = z.object({ id: UUID });

const PutItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
  taxRate: z.number().min(0).max(100).optional(),
  discount: z.number().min(0).max(100).optional(),
});

const PutBodySchema = z.object({
  id: UUID,
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(2000).optional(),
  dueDate: ISODate.optional(),
  // Full draft-edit fields (all optional — partial PUT supported for back-compat).
  clientId: UUID.optional(),
  invoiceDate: ISODate.optional(),
  billingPeriodStart: ISODate.optional(),
  billingPeriodEnd: ISODate.optional(),
  taxRate: z.number().min(0).max(100).optional(),
  currencyCode: z.string().min(1).max(8).optional(),
  exchangeRate: z.number().positive().optional(),
  items: z.array(PutItemSchema).min(1).optional(),
});

const PostBodySchema = z.object({
  id: UUID,
  action: z.enum(['approve', 'send', 'cancel']),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const queryParsed = GetQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      return apiResponse.validationError(res, queryParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const { id } = queryParsed.data;

    try {
      const rows = (await sql`
        SELECT ci.id, ci.invoice_number, ci.customer_id, ci.client_id,
               ci.subtotal, ci.tax_rate, ci.tax_amount, ci.total_amount,
               ci.amount_paid, ci.status,
               to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
               to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
               ci.sent_at, ci.paid_at, ci.notes, ci.internal_notes,
               ci.project_id, ci.gl_journal_entry_id,
               ci.email_sent_at, ci.email_sent_to,
               ci.online_payment_enabled, ci.payment_url,
               ci.currency_code, ci.exchange_rate, ci.functional_total,
               to_char(ci.billing_period_start, 'YYYY-MM-DD') AS billing_period_start,
               to_char(ci.billing_period_end, 'YYYY-MM-DD') AS billing_period_end,
               ci.created_at, ci.updated_at,
               c.name AS client_name, c.email AS client_email
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.id = ${id}::UUID AND ci.company_id = ${companyId}
      `) as Row[];
      if (rows.length === 0) return apiResponse.notFound(res, 'Invoice', id);

      const items = (await sql`
        SELECT cii.* FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id WHERE cii.invoice_id = ${id}::UUID AND ci.company_id = ${companyId} ORDER BY cii.created_at
      `) as Row[];

      return apiResponse.success(res, { ...rows[0], items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Customer invoice detail GET error', { error: msg }, 'customer-invoice-detail');
      return apiResponse.internalError(res, err, `Failed to load invoice: ${msg}`);
    }
  }

  if (req.method === 'PUT') {
    const putParsed = PutBodySchema.safeParse(req.body);
    if (!putParsed.success) {
      return apiResponse.validationError(res, putParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const {
      id, notes, internalNotes, dueDate,
      clientId, invoiceDate, billingPeriodStart, billingPeriodEnd,
      taxRate, currencyCode, exchangeRate, items,
    } = putParsed.data;

    // taxRate / currencyCode / exchangeRate only affect computed totals, which are
    // only recomputed when `items` is supplied. Reject the misleading combination
    // rather than silently dropping the value.
    if (!items && (taxRate !== undefined || currencyCode !== undefined || exchangeRate !== undefined)) {
      return apiResponse.badRequest(res, 'taxRate, currencyCode and exchangeRate require items[] to recompute totals');
    }

    const fxCode = currencyCode ? currencyCode.trim().toUpperCase() : null;
    const fxRateOverride = (typeof exchangeRate === 'number' && exchangeRate > 0) ? exchangeRate : null;

    // Wrap header UPDATE + items DELETE/INSERT in one transaction so partial
    // failures cannot leave an invoice with no line items.
    // Distinguishes 404 (no row owned by tenant) from 400 (row exists but not draft)
    // by selecting status inside the same transaction before updating.
    // Totals are computed inside the tx so we can fall back to the row's
    // existing exchange_rate when the caller edits items on an FX invoice
    // without re-supplying the rate (otherwise functional_total would silently
    // collapse to total × 1).
    const result = await withTransaction(async (tx) => {
      const ownedRows = (await tx`
        SELECT status, currency_code, exchange_rate, tax_rate FROM customer_invoices
         WHERE id = ${id}::UUID AND company_id = ${companyId}
         FOR UPDATE
      `) as Row[];
      if (ownedRows.length === 0) {
        return { kind: 'not_found' as const };
      }
      if (String(ownedRows[0]!.status) !== 'draft') {
        return { kind: 'not_draft' as const };
      }
      const existingRate = Number(ownedRows[0]!.exchange_rate ?? 1);

      // Defence-in-depth: clientId must belong to the same tenant. The FK
      // alone does not check company_id, so without this guard a caller could
      // re-point an invoice at another tenant's customer.
      if (clientId !== undefined) {
        const customerOwned = (await tx`
          SELECT 1 FROM customers
           WHERE id = ${clientId}::UUID AND company_id = ${companyId}
           LIMIT 1
        `) as Row[];
        if (customerOwned.length === 0) {
          return { kind: 'bad_client' as const };
        }
      }

      let computed: { subtotal: number; tax: number; total: number; functionalTotal: number; rate: number } | null = null;
      if (items) {
        // Fall back to the invoice's existing tax_rate (not a hardcoded 15%) so
        // recomputed totals stay correct when the caller doesn't re-send taxRate.
        const existingTaxRate = Number(ownedRows[0]!.tax_rate ?? 15);
        const rate = taxRate ?? existingTaxRate;
        let subtotal = 0;
        for (const it of items) {
          const lineNet = it.quantity * it.unitPrice * (1 - ((it.discount ?? 0) / 100));
          subtotal += lineNet;
        }
        subtotal = Math.round(subtotal * 100) / 100;
        const tax = Math.round(subtotal * (rate / 100) * 100) / 100;
        const total = Math.round((subtotal + tax) * 100) / 100;
        const fxRate = fxRateOverride ?? existingRate;
        const functionalTotal = Math.round(total * fxRate * 100) / 100;
        computed = { subtotal, tax, total, functionalTotal, rate };
      }

      await tx`
        UPDATE customer_invoices
           SET notes = COALESCE(${notes ?? null}, notes),
               internal_notes = COALESCE(${internalNotes ?? null}, internal_notes),
               due_date = COALESCE(${dueDate ?? null}, due_date),
               customer_id = COALESCE(${clientId ?? null}::UUID, customer_id),
               client_id = COALESCE(${clientId ?? null}::UUID, client_id),
               invoice_date = COALESCE(${invoiceDate ?? null}, invoice_date),
               billing_period_start = COALESCE(${billingPeriodStart ?? null}, billing_period_start),
               billing_period_end = COALESCE(${billingPeriodEnd ?? null}, billing_period_end),
               tax_rate = COALESCE(${computed?.rate ?? null}, tax_rate),
               subtotal = COALESCE(${computed?.subtotal ?? null}, subtotal),
               tax_amount = COALESCE(${computed?.tax ?? null}, tax_amount),
               total_amount = COALESCE(${computed?.total ?? null}, total_amount),
               functional_total = COALESCE(${computed?.functionalTotal ?? null}, functional_total),
               currency_code = COALESCE(${fxCode}, currency_code),
               exchange_rate = COALESCE(${fxRateOverride}, exchange_rate),
               updated_at = NOW()
         WHERE id = ${id}::UUID AND company_id = ${companyId} AND status = 'draft'
      `;

      if (items && computed) {
        // Tenant ownership is already enforced by the FOR UPDATE select above,
        // so a plain delete by invoice_id is sufficient here.
        await tx`DELETE FROM customer_invoice_items WHERE invoice_id = ${id}::UUID`;
        // Preserve the invoice's existing currency when the caller did not
        // re-send `currencyCode`. Falling back to ZAR would silently corrupt
        // line-item currency on FX invoices.
        const existingCurrency = String(ownedRows[0]!.currency_code ?? 'ZAR');
        const lineCurrency = fxCode || existingCurrency;
        for (const it of items) {
          const qty = it.quantity;
          const lineAmount = Math.round(qty * it.unitPrice * (1 - ((it.discount ?? 0) / 100)) * 100) / 100;
          await tx`
            INSERT INTO customer_invoice_items (
              invoice_id, description, unit_price, quantity, amount, tax_rate, currency_code
            ) VALUES (
              ${id}::UUID, ${it.description}, ${it.unitPrice},
              ${qty}, ${lineAmount}, ${it.taxRate ?? computed.rate}, ${lineCurrency}
            )
          `;
        }
      }

      return { kind: 'ok' as const };
    });

    if (result.kind === 'not_found') return apiResponse.notFound(res, 'Invoice', id);
    if (result.kind === 'not_draft') return apiResponse.badRequest(res, 'Only draft invoices can be edited');
    if (result.kind === 'bad_client') return apiResponse.badRequest(res, 'clientId does not belong to this company');

    log.info('Customer invoice updated', { id, hasItems: Boolean(items) });
    return apiResponse.success(res, { updated: true });
  }

  if (req.method === 'POST') {
    const postParsed = PostBodySchema.safeParse(req.body);
    if (!postParsed.success) {
      return apiResponse.validationError(res, postParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const { id, action } = postParsed.data;
    const actionUserId = (req as CompanyAuthedRequest).user?.id || 'system';

    // P1.1 (audit C1): cancel must reverse the approval journal, not just
    // flip status. The service throws on guard violations (payments applied,
    // already cancelled, locked period) — nothing flips in that case.
    if (action === 'cancel') {
      try {
        const cancelled = await cancelCustomerInvoice(companyId, id, actionUserId);
        if (!cancelled) return apiResponse.notFound(res, 'Invoice', id);
        log.info('Customer invoice cancelled', { id, reversalJournalEntryId: cancelled.reversalJournalEntryId });
        return apiResponse.success(res, { id, status: 'cancelled', reversalJournalEntryId: cancelled.reversalJournalEntryId });
      } catch (cancelErr) {
        return apiResponse.badRequest(res, cancelErr instanceof Error ? cancelErr.message : 'Failed to cancel invoice');
      }
    }

    const newStatus = action === 'approve' ? 'approved' : 'sent';
    // Cancel is terminal: approving/sending a cancelled invoice would resurrect
    // a document whose journal has been reversed.
    const actionResult = await sql`
      UPDATE customer_invoices
      SET status = ${newStatus}, updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId} AND status != 'cancelled'
      RETURNING id
    `;
    if (actionResult.length === 0) {
      const exists = await sql`SELECT id FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}`;
      if (exists.length === 0) return apiResponse.notFound(res, 'Invoice', id);
      return apiResponse.badRequest(res, `Cannot ${action} a cancelled invoice`);
    }

    // Post to GL on approve (accrual accounting: DR AR, CR Revenue, CR VAT Output)
    let glJournalEntryId: string | null = null;
    if (action === 'approve') {
      try {
        glJournalEntryId = await postCustomerInvoiceToGL(companyId, id, actionUserId);
        log.info('Customer invoice GL posted on approve', { id, glJournalEntryId });
      } catch (glErr) {
        log.error('GL posting failed on invoice approve (invoice still approved)', { id, error: glErr });
      }
    }

    // PRD-06 Phase 1: seal the rendered PDF as evidence on approve/send.
    // Non-blocking: if storage is flaky the status transition still succeeds;
    // a later admin can re-trigger via POST /ar/invoice/[id]/pdf.
    let evidenceDocumentId: string | null = null;
    if (action === 'approve' || action === 'send') {
      try {
        const snapshot = await snapshotInvoicePdf(companyId, id);
        evidenceDocumentId = snapshot.documentId;
        log.info('Customer invoice PDF snapshot sealed', {
          id, documentId: snapshot.documentId, wasExisting: snapshot.wasExisting,
        });
      } catch (snapErr) {
        log.error('PDF snapshot failed (invoice still transitioned)', { id, error: snapErr });
      }
    }

    log.info('Customer invoice action', { id, action, newStatus });
    return apiResponse.success(res, { id, status: newStatus, glJournalEntryId, evidenceDocumentId });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
