/**
 * Customer Invoice Detail API
 * GET  ?id=UUID — single invoice with line items
 * PUT  { id, ...fields } — update draft invoice
 * POST { id, action } — status actions (approve, send, cancel)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';
import {
  cancelCustomerInvoice,
  InvoiceNotFoundError,
  InvoiceHasPaymentsError,
} from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryService';
import {
  GetQuerySchema,
  PutBodySchema,
  PostBodySchema,
} from '@/lib/schemas/customerInvoiceDetail';
import { getCustomerInvoiceDetail } from '@/modules/accounting/services/ar/customerInvoiceReadService';
type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const queryParsed = GetQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      return apiResponse.validationError(res, queryParsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    const { id } = queryParsed.data;

    try {
      const detail = await getCustomerInvoiceDetail(companyId, id);
      if (!detail) return apiResponse.notFound(res, 'Invoice', id);

      return apiResponse.success(res, detail);
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
    const userId = (req as CompanyAuthedRequest).user?.id || 'system';

    // Cancel reverses the approval GL journal and zeroes the outstanding
    // balance (see customerInvoiceCancelService). Handled in the service layer
    // so a plain status flip can never orphan a posted journal.
    if (action === 'cancel') {
      try {
        const { reversedJournalEntryId } = await cancelCustomerInvoice(companyId, id, userId);
        log.info('Customer invoice action', { id, action, newStatus: 'cancelled', reversedJournalEntryId });
        return apiResponse.success(res, {
          id, status: 'cancelled', glJournalEntryId: null,
          evidenceDocumentId: null, reversedJournalEntryId,
        });
      } catch (err) {
        if (err instanceof InvoiceNotFoundError) return apiResponse.notFound(res, 'Invoice', id);
        if (err instanceof InvoiceHasPaymentsError) return apiResponse.badRequest(res, err.message);
        // The GL reversal cannot post into a closed/locked fiscal period; surface
        // that as a 400 instead of a 500 so the caller knows to reopen the period.
        if (err instanceof ClosedFiscalPeriodError) {
          return apiResponse.badRequest(res, `Cannot cancel: the invoice's journal is in a ${err.periodStatus} fiscal period. Reopen the period, then retry.`);
        }
        throw err;
      }
    }

    if (action === 'approve') {
      try {
        const result = await approveCustomerInvoice(companyId, id, userId);
        log.info('Customer invoice action', { id, action, newStatus: result.status });
        return apiResponse.success(res, {
          id, status: result.status, glJournalEntryId: result.glJournalEntryId,
          evidenceDocumentId: result.evidenceDocumentId,
        });
      } catch (err) {
        if (err instanceof InvoiceNotApprovableError) {
          return err.notFound ? apiResponse.notFound(res, 'Invoice', id) : apiResponse.badRequest(res, err.message);
        }
        throw err;
      }
    }

    // action === 'send' — the only branch remaining (PostBodySchema restricts
    // action to 'approve' | 'send' | 'cancel', both handled above).
    const newStatus = 'sent';

    // 'sent' is in AR_OPEN_STATUSES — sending a cancelled invoice would
    // resurrect it into outstanding AR against a net-zero reversed journal.
    const sent = (await sql`
      UPDATE customer_invoices
      SET status = 'sent', updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}
        AND status != 'cancelled'
      RETURNING id
    `) as Row[];
    if (sent.length === 0) {
      const cur = (await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}`) as Row[];
      if (cur.length === 0) return apiResponse.notFound(res, 'Invoice', id);
      return apiResponse.badRequest(res, 'Cannot send a cancelled invoice');
    }

    // PRD-06 Phase 1: seal the rendered PDF as evidence on send.
    // Non-blocking: if storage is flaky the status transition still succeeds;
    // a later admin can re-trigger via POST /ar/invoice/[id]/pdf.
    let evidenceDocumentId: string | null = null;
    try {
      const snapshot = await snapshotInvoicePdf(companyId, id);
      evidenceDocumentId = snapshot.documentId;
      log.info('Customer invoice PDF snapshot sealed', {
        id, documentId: snapshot.documentId, wasExisting: snapshot.wasExisting,
      });
    } catch (snapErr) {
      log.error('PDF snapshot failed (invoice still transitioned)', { id, error: snapErr });
    }

    log.info('Customer invoice action', { id, action, newStatus });
    return apiResponse.success(res, { id, status: newStatus, glJournalEntryId: null, evidenceDocumentId });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
