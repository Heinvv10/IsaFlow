/**
 * POST /api/accounting/customer-invoices/[id]/pay-now
 *
 * One-click "Pay Now" for an open customer invoice. The admin user clicks
 * the button on the invoice page and the response gives them a Paystack
 * hosted-checkout URL the browser opens in a new tab — no copy/paste,
 * no separate "enable online payment" toggle.
 *
 * Side effects:
 *   - If the invoice has no portal token, generate one + flag online_payment_enabled.
 *   - Initialise a Paystack transaction for the outstanding balance.
 *   - Persist a paystack_payment_requests row so the webhook can finalise.
 *
 * Response: { checkoutUrl, reference, paymentUrl }
 *   - checkoutUrl  → open in new tab; this is the Paystack hosted page.
 *   - paymentUrl   → optional follow-up; the public portal link if you
 *                    also want to copy it for the customer.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes } from 'crypto';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { initializeTransaction } from '@/modules/billing/services/paystackClient';

interface InvoiceRow {
  id: string;
  company_id: string;
  invoice_number: string;
  total: string;
  amount_paid: string | null;
  client_id: string | null;
  customer_id: string | null;
  status: string;
  payment_url: string | null;
  online_payment_enabled: boolean;
  client_name: string;
  client_email: string | null;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const invoiceId = String(req.query.id ?? '');
  if (!invoiceId) return apiResponse.badRequest(res, 'invoice id required');

  const invRows = await sql<InvoiceRow>`
    SELECT ci.id, ci.company_id, ci.invoice_number,
           ci.total_amount AS total, ci.amount_paid,
           ci.client_id, ci.customer_id, ci.status,
           ci.payment_url, ci.online_payment_enabled,
           COALESCE(c.name, 'Customer') AS client_name,
           c.email AS client_email
      FROM customer_invoices ci
      LEFT JOIN clients c ON c.id = COALESCE(ci.client_id, ci.customer_id)
     WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
     LIMIT 1
  `;
  const invoice = invRows[0];
  if (!invoice) return apiResponse.notFound(res, 'Invoice');

  const outstandingCents = Math.round(
    (Number(invoice.total) - Number(invoice.amount_paid ?? 0)) * 100,
  );
  if (outstandingCents <= 0) {
    return apiResponse.badRequest(res, 'Invoice has no outstanding balance');
  }

  // Ensure a portal token exists. If we already have one we reuse it; the
  // public portal page can also redirect to Paystack via the same token.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl || /localhost|127\.0\.0\.1|\[::1\]/.test(appUrl)) {
    log.error(
      'NEXT_PUBLIC_APP_URL missing or points at localhost — refusing to generate portal URL',
      { appUrl },
      'PayNow',
    );
    return apiResponse.internalError(res, 'Server URL misconfigured');
  }

  const clientIdForPortal = invoice.client_id ?? invoice.customer_id;
  if (!clientIdForPortal) {
    return apiResponse.badRequest(res, 'Invoice has no linked customer');
  }

  let paymentUrl = invoice.payment_url;
  if (!invoice.online_payment_enabled || !paymentUrl) {
    const linkRows = await sql<{ token: string }>`
      INSERT INTO portal_payment_links (invoice_id, client_id, amount)
      VALUES (
        ${invoice.id}::UUID,
        ${clientIdForPortal}::UUID,
        ${(outstandingCents / 100).toFixed(2)}::NUMERIC
      )
      RETURNING token
    `;
    const token = linkRows[0]?.token;
    if (!token) {
      return apiResponse.internalError(res, 'Failed to generate portal token');
    }
    paymentUrl = `${appUrl}/portal/pay/${token}`;
    await sql`
      UPDATE customer_invoices
         SET online_payment_enabled = TRUE,
             payment_url = ${paymentUrl},
             updated_at = NOW()
       WHERE id = ${invoice.id}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  const payerEmail =
    invoice.client_email && invoice.client_email.includes('@')
      ? invoice.client_email
      : (user?.email ?? `paynow+${invoice.id}@noreply.isaflow.co.za`);

  const reference = `inv_${invoice.id.replace(/-/g, '').slice(0, 12)}_${randomBytes(6).toString('hex')}`;
  const callbackUrl = `${appUrl}/portal/payments/paystack/return?ref=${encodeURIComponent(reference)}`;

  try {
    const init = await initializeTransaction({
      email: payerEmail,
      amountCents: outstandingCents,
      reference,
      callbackUrl,
      metadata: {
        purpose: 'customer_invoice',
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        company_id: invoice.company_id,
        initiated_by: 'admin_pay_now',
        admin_user_id: user?.id ?? null,
      },
    });

    await sql`
      INSERT INTO paystack_payment_requests (
        company_id, purpose, customer_invoice_id,
        paystack_reference, paystack_access_code, authorization_url,
        amount_cents, currency, status, payer_name, payer_email
      ) VALUES (
        ${invoice.company_id}, 'customer_invoice', ${invoice.id},
        ${init.reference}, ${init.accessCode}, ${init.authorizationUrl},
        ${outstandingCents}, 'ZAR', 'pending', ${invoice.client_name}, ${payerEmail}
      )
    `;

    return apiResponse.success(res, {
      checkoutUrl: init.authorizationUrl,
      reference: init.reference,
      paymentUrl,
    });
  } catch (err) {
    log.error(
      'Pay Now: Paystack initialise failed',
      { invoiceId: invoice.id, err: err instanceof Error ? err.message : String(err) },
      'PayNow',
    );
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
