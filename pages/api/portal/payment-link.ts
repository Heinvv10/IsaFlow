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
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { createPaymentLink, getPaymentLink } from '@/modules/accounting/services/ar/portalService';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;

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
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return apiResponse.badRequest(res, 'amount must be a positive number');
    }

    const userId = (req as AuthenticatedNextApiRequest).user.id;
    const companyRows = (await sql`
      SELECT company_id FROM company_users
      WHERE user_id = ${userId}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `) as Row[];
    if (companyRows.length === 0) {
      return apiResponse.badRequest(res, 'No company assigned to this user');
    }
    const companyId = companyRows[0]!.company_id as string;

    const invoice = (await sql`
      SELECT id FROM customer_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    if (invoice.length === 0) return apiResponse.notFound(res, 'Invoice not found');

    const token = await createPaymentLink(invoiceId, clientId, amountNum);
    return apiResponse.success(res, { token, url: `/portal/pay/${token}` });
}

const authedPost = withAuth(postHandler);

async function router(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return authedPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withErrorHandler(router);
