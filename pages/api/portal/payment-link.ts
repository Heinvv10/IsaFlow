/**
 * Client Portal — Payment Link API
 * GET  — get payment link details by token
 * POST — create a new payment link for an invoice
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { createPaymentLink, getPaymentLink } from '@/modules/accounting/services/portalService';
import { generatePayFastForm } from '@/modules/accounting/services/paymentGatewayService';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const token = req.query.token as string;
    if (!token) return apiResponse.badRequest(res, 'token is required');
    const link = await getPaymentLink(token);
    if (!link) return apiResponse.notFound(res, 'Payment link');

    // Enrich with invoice details and PayFast form data
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

        // Generate PayFast form data if online payment is enabled
        if (invoiceRows[0].online_payment_enabled) {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3101';
          const companyId = invoiceRows[0].company_id as string;
          try {
            const formData = await generatePayFastForm(
              companyId,
              link.invoiceId,
              `${appUrl}/portal/pay/${token}?payment_status=success`,
              `${appUrl}/portal/pay/${token}?payment_status=cancelled`,
              `${appUrl}/api/accounting/payment-gateway-itn`,
            );
            enriched.payfastFormData = formData;
          } catch (e) {
            log.error('Failed to generate PayFast form for portal', e instanceof Error ? { message: e.message } : { error: e }, 'PaymentLink');
          }
        }
      }
    } catch (e) {
      log.error('Failed to enrich payment link', e instanceof Error ? { message: e.message } : { error: e }, 'PaymentLink');
    }

    return apiResponse.success(res, enriched);
  }

  if (req.method === 'POST') {
    const { invoiceId, clientId, amount } = req.body;
    if (!invoiceId || !clientId || !amount) {
      return apiResponse.badRequest(res, 'invoiceId, clientId, and amount are required');
    }

    // Resolve the authenticated user's company
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

    // Verify invoice belongs to this company
    const invoice = (await sql`
      SELECT id FROM customer_invoices
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    if (invoice.length === 0) return apiResponse.notFound(res, 'Invoice not found');

    const token = await createPaymentLink(invoiceId, clientId, Number(amount));
    return apiResponse.success(res, { token, url: `/portal/pay/${token}` });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
