/**
 * POST /api/portal/payments/stitch/create
 * Public (portal) — creates a Stitch payment request for a customer invoice
 * via a signed portal token. Returns the Stitch checkout URL (with our
 * redirect_uri appended) that the browser should redirect to.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomBytes } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createPaymentLink } from '@/modules/billing/services/stitchClient';

interface InvoiceRow {
  id: string;
  company_id: string;
  invoice_number: string;
  total: string;
  amount_paid: string | null;
  client_name: string;
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
           COALESCE(c.name, 'Customer') AS client_name, ci.status
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

  const externalReference = `inv_${invoice.id}_${randomBytes(6).toString('hex')}`;

  const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/portal/payments/stitch/return`;

  try {
    const stitch = await createPaymentLink({
      amountCents: outstandingCents,
      payerName: invoice.client_name,
      merchantReference: invoice.invoice_number.slice(0, 30),
      externalReference,
      redirectUrl,
      description: `Invoice ${invoice.invoice_number}`,
    });

    await sql`
      INSERT INTO stitch_payment_requests (
        company_id, purpose, customer_invoice_id,
        stitch_payment_id, external_reference, checkout_url,
        amount_cents, currency, status, payer_name
      ) VALUES (
        ${invoice.company_id}, 'customer_invoice', ${invoice.id},
        ${stitch.id}, ${externalReference}, ${stitch.url},
        ${outstandingCents}, 'ZAR', 'pending', ${invoice.client_name}
      )
    `;

    return apiResponse.success(res, { checkoutUrl: stitch.url, externalReference });
  } catch (err) {
    log.error(
      'Failed to create Stitch payment request',
      { invoiceId: invoice.id, err: err instanceof Error ? err.message : String(err) },
      'StitchPortal',
    );
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
}

export default withErrorHandler(handler);
