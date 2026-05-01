/**
 * POST /api/portal/payments/paystack/create
 * Public (portal) — initialise a Paystack transaction for a customer invoice
 * via a signed portal token. Returns the hosted-checkout URL the browser
 * redirects to, plus the reference we'll use to verify on return.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';
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
  client_name: string;
  client_email: string | null;
  status: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { token } = (req.body ?? {}) as { token?: string };
  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Missing portal token');
  }

  const linkRows = await sql<{
    invoice_id: string;
    expires_at: Date | string;
    status: string | null;
  }>`
    SELECT invoice_id, expires_at, status
    FROM portal_payment_links
    WHERE token = ${token}
    LIMIT 1
  `;
  const link = linkRows[0];
  if (!link) return apiResponse.notFound(res, 'Payment link');
  if (link.status && link.status !== 'active') {
    return apiResponse.badRequest(res, 'Payment link not active');
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return apiResponse.badRequest(res, 'Payment link expired');
  }

  const invRows = await sql<InvoiceRow>`
    SELECT ci.id, ci.company_id, ci.invoice_number,
           ci.total_amount AS total, ci.amount_paid,
           COALESCE(c.name, 'Customer') AS client_name,
           c.email AS client_email,
           ci.status
    FROM customer_invoices ci
    LEFT JOIN clients c ON c.id = COALESCE(ci.client_id, ci.customer_id)
    WHERE ci.id = ${link.invoice_id}
    LIMIT 1
  `;
  const invoice = invRows[0];
  if (!invoice) return apiResponse.notFound(res, 'Invoice');

  const outstandingCents = Math.round(
    (Number(invoice.total) - Number(invoice.amount_paid ?? 0)) * 100,
  );
  if (outstandingCents <= 0) {
    return apiResponse.badRequest(res, 'Invoice already paid');
  }

  // Paystack requires a payer email. We fall back to a synthetic per-token
  // address so payment still works even if the customer has no email on file.
  const payerEmail =
    invoice.client_email && invoice.client_email.includes('@')
      ? invoice.client_email
      : `portal+${token}@noreply.isaflow.co.za`;

  const reference = `inv_${invoice.id.replace(/-/g, '').slice(0, 12)}_${randomBytes(6).toString('hex')}`;
  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/portal/payments/paystack/return?ref=${encodeURIComponent(reference)}`;

  try {
    const init = await initializeTransaction({
      email: payerEmail,
      amountCents: outstandingCents,
      reference,
      callbackUrl,
      metadata: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        company_id: invoice.company_id,
        portal_token: token,
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
    });
  } catch (err) {
    log.error(
      'Failed to initialise Paystack transaction',
      { invoiceId: invoice.id, err: err instanceof Error ? err.message : String(err) },
      'PaystackPortal',
    );
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
}

export default withErrorHandler(handler);
