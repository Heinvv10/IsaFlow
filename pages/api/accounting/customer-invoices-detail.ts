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
import { sql } from '@/lib/neon';
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
import { ReversalBeforeOriginalError } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import {
  GetQuerySchema,
  PutBodySchema,
  PostBodySchema,
} from '@/lib/schemas/customerInvoiceDetail';
import { getCustomerInvoiceDetail } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { editDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { describeApprovalGate } from '@/modules/accounting/services/gl/approvalGate';
import { ApprovalDocumentNotFoundError } from '@/modules/accounting/services/gl/approvalDocuments';
import { DocumentCurrencyError } from '@/modules/accounting/services/shared/documentCurrency';
type Row = Record<string, unknown>;

/**
 * The gate's answer for the detail GET. This GET also serves a soft-deleted
 * invoice, which the gate treats as no document (and the backstop refuses to
 * post): it has no approval state to show.
 */
async function describeInvoiceApproval(companyId: string, id: string) {
  try {
    return await describeApprovalGate(companyId, 'customer_invoice', id);
  } catch (err) {
    if (err instanceof ApprovalDocumentNotFoundError) return null;
    throw err;
  }
}

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

      // R-035 PR4: the derived approval state while the invoice can still be approved.
      const approval = ['draft', 'pending_approval'].includes(String(detail.status))
        ? await describeInvoiceApproval(companyId, id) : null;
      return apiResponse.success(res, { ...detail, approval });
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
    const { id, items, taxRate, currencyCode, exchangeRate } = putParsed.data;

    // taxRate / currencyCode / exchangeRate only affect computed totals, which are
    // only recomputed when `items` is supplied. Reject the misleading combination
    // rather than silently dropping the value.
    if (!items && (taxRate !== undefined || currencyCode !== undefined || exchangeRate !== undefined)) {
      return apiResponse.badRequest(res, 'taxRate, currencyCode and exchangeRate require items[] to recompute totals');
    }

    // R-035 PR4: the editor is recorded as an author when the edit moves the approval content.
    const result = await editDraftCustomerInvoice(companyId, (req as CompanyAuthedRequest).user.id, putParsed.data);

    if (result.kind === 'not_found') return apiResponse.notFound(res, 'Invoice', id);
    if (result.kind === 'not_draft') return apiResponse.badRequest(res, 'Only draft invoices can be edited');
    if (result.kind === 'bad_client') return apiResponse.badRequest(res, 'clientId does not belong to this company');
    if (result.kind === 'rate_required') return apiResponse.badRequest(res, 'exchangeRate is required when currencyCode changes');
    if (result.kind === 'currency_refused') return apiResponse.badRequest(res, result.message);

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
        // Its own message says what is wrong — a reversal dated before a future-dated
        // invoice — which the generic closed-period text below would lose (R-012).
        if (err instanceof ReversalBeforeOriginalError) return apiResponse.badRequest(res, err.message);
        if (err instanceof ClosedFiscalPeriodError) {
          return apiResponse.badRequest(res, `Cannot cancel: the invoice's journal is in a ${err.periodStatus} fiscal period. Reopen the period, then retry.`);
        }
        // The reversal could not be dated out of a locked (filed) VAT period.
        if (err instanceof VatPeriodLockedError) {
          return apiResponse.badRequest(res, `Cannot cancel: ${err.message}`);
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
        // R-035 PR4: raised under the row lock before any write — a 409 that commits nothing.
        if (respondIfApprovalRequired(res, err)) return;
        // FX PR0: a foreign invoice while the company has not enabled them; also before any write.
        if (err instanceof DocumentCurrencyError) return apiResponse.badRequest(res, err.message);
        throw err;
      }
    }

    // action === 'send' — the only branch remaining (PostBodySchema restricts
    // action to 'approve' | 'send' | 'cancel', both handled above).
    const newStatus = 'sent';

    // Only an approved (posted) invoice can be sent; re-sending keeps 'sent'.
    // 'sent' is in the AR population: a draft marked sent is AR with no
    // journal behind it, a cancelled one is resurrected against a reversed
    // journal, and a paid one is demoted back to open.
    const sent = (await sql`
      UPDATE customer_invoices
      SET status = 'sent', updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}
        AND status IN ('approved', 'sent')
      RETURNING id
    `) as Row[];
    if (sent.length === 0) {
      const cur = (await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID AND company_id = ${companyId}`) as Row[];
      if (cur.length === 0) return apiResponse.notFound(res, 'Invoice', id);
      return apiResponse.badRequest(res, cur[0]!.status === 'cancelled'
        ? 'Cannot send a cancelled invoice'
        : `Cannot send a ${String(cur[0]!.status)} invoice — only an approved invoice can be sent`);
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
