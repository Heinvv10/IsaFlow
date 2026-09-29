/**
 * Client Portal — Payment Link API
 * GET  — get payment link details by token (enriched with invoice context)
 * POST — create a new payment link for an invoice
 *
 * Note: gateway selection is decoupled from this endpoint. The portal page
 * calls /api/portal/payments/paystack/create to start a transaction.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { createPaymentLink, getPaymentLink } from '@/modules/accounting/services/ar/portalService';
import { assertCustomerInCompany, CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;

/** A body amount as text: plain decimal, at most cents (no '0x10', '1e3', ' 7 ', 12.345). */
const AMOUNT_STRING_RE = /^\d+(\.\d{1,2})?$/;
/** portal_payment_links.amount is numeric(15,2). */
const MAX_LINK_AMOUNT = 9_999_999_999_999.99;

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
    const token = req.query.token as string;
    if (!token) return apiResponse.badRequest(res, 'token is required');
    const link = await getPaymentLink(token);
    if (!link) return apiResponse.notFound(res, 'Payment link');

    const enriched: Record<string, unknown> = { ...link };
    try {
      const invoiceRows = (await sql`
        SELECT ci.invoice_number, ci.due_date, ci.online_payment_enabled, ci.company_id,
               co.name AS company_name
        FROM customer_invoices ci
        LEFT JOIN companies co ON co.id = ci.company_id
        WHERE ci.id = ${link.invoiceId}::UUID
      `) as Row[];

      if (invoiceRows[0]) {
        enriched.invoiceNumber = invoiceRows[0].invoice_number;
        enriched.dueDate = invoiceRows[0].due_date;
        enriched.companyName = invoiceRows[0].company_name;
        enriched.onlinePaymentEnabled = Boolean(invoiceRows[0].online_payment_enabled);
      }
    } catch (e) {
      log.error('Failed to enrich payment link', e instanceof Error ? { message: e.message } : { error: e }, 'PaymentLink');
    }

    return apiResponse.success(res, enriched);
}

async function postHandler(req: NextApiRequest, res: NextApiResponse) {
    const { invoiceId, clientId, amount } = req.body;
    if (!invoiceId || !clientId || !amount) {
      return apiResponse.badRequest(res, 'invoiceId, clientId, and amount are required');
    }
    if (!isUuidParam(invoiceId)) {
      return apiResponse.badRequest(res, 'invoiceId must be a UUID');
    }
    if (typeof clientId !== 'string') {
      return apiResponse.badRequest(res, 'clientId must be a string');
    }
    // A number is checked by its shortest round-trip text, so 12.34 passes and 12.345 (which the
    // column would silently round to 12.35) does not, the same as the string '12.345'.
    if ((typeof amount !== 'number' && typeof amount !== 'string') || !AMOUNT_STRING_RE.test(String(amount))) {
      return apiResponse.badRequest(res, 'amount must be a positive number in whole cents');
    }
    // '0.00' passes the text check; the floor refuses it, so no link is ever for R0.00.
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > MAX_LINK_AMOUNT) {
      return apiResponse.badRequest(res, 'amount must be between 0.01 and 9 999 999 999 999.99');
    }

    // K-101: the active company withAuth verified, not the user's default one.
    const companyId = (req as CompanyAuthedRequest).companyId;

    const invoice = (await sql`
      SELECT COALESCE(client_id, customer_id) AS customer_id FROM customer_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
        AND status != 'cancelled'
    `) as Row[];
    if (invoice.length === 0) return apiResponse.notFound(res, 'Invoice not found');
    // A link pays THIS invoice, so it is for this invoice's customer only.
    if (clientId.toLowerCase() !== String(invoice[0]!.customer_id).toLowerCase()) {
      return apiResponse.badRequest(res, "clientId is not this invoice's customer");
    }

    // R-067: clientId comes from the request body, and the unauthenticated GET
    // above hands the link's client_id to anyone holding the token.
    try {
      await assertCustomerInCompany(companyId, clientId);
    } catch (err) {
      if (err instanceof CustomerNotInCompanyError) return apiResponse.badRequest(res, err.message);
      throw err;
    }
    const token = await createPaymentLink(invoiceId, clientId, amountNum);
    return apiResponse.success(res, { token, url: `/portal/pay/${token}` });
}

// R-157: a link is a public credential to pay this invoice, so creating one is a write:
// CSRF-checked, and owner/admin/manager only, refused before the first write (withAuth COMMITs a 4xx).
// withErrorHandler must sit INSIDE withAuth as well: withAuth defers res.end until COMMIT/ROLLBACK
// and replays it only on a normal return, so a throw that reached the router's outer
// withErrorHandler was rolled back but its 500 never reached the client.
const authedPost = withAuth(withErrorHandler(withCsrf(withWriteAccess(postHandler))));

async function router(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return authedPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withErrorHandler(router);
