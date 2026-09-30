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
import { resolveLinkCharge } from '@/modules/accounting/services/ar/portalLinkCharge';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { token } = (req.body ?? {}) as { token?: string };
  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Missing portal token');
  }

  // R-167: the link's own amount, capped at what the invoice still owes (portalLinkCharge).
  const resolved = await resolveLinkCharge(token);
  if (!resolved.ok) {
    switch (resolved.reason) {
      case 'link_not_found': return apiResponse.notFound(res, 'Payment link');
      case 'link_not_active': return apiResponse.badRequest(res, 'Payment link not active');
      case 'link_expired': return apiResponse.badRequest(res, 'Payment link expired');
      case 'invoice_gone': return apiResponse.notFound(res, 'Invoice');
      case 'nothing_owed': return apiResponse.badRequest(res, 'Invoice already paid');
    }
  }
  const charge = resolved.charge;

  // Paystack requires a payer email. We fall back to a synthetic per-token
  // address so payment still works even if the customer has no email on file.
  const payerEmail =
    charge.clientEmail && charge.clientEmail.includes('@')
      ? charge.clientEmail
      : `portal+${token}@noreply.isaflow.co.za`;

  const reference = `inv_${charge.invoiceId.replace(/-/g, '').slice(0, 12)}_${randomBytes(6).toString('hex')}`;
  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/portal/payments/paystack/return?ref=${encodeURIComponent(reference)}`;

  try {
    const init = await initializeTransaction({
      email: payerEmail,
      amountCents: charge.chargeCents,
      reference,
      callbackUrl,
      metadata: {
        invoice_id: charge.invoiceId,
        invoice_number: charge.invoiceNumber,
        company_id: charge.companyId,
        portal_token: token,
      },
    });

    await sql`
      INSERT INTO paystack_payment_requests (
        company_id, purpose, customer_invoice_id,
        paystack_reference, paystack_access_code, authorization_url,
        amount_cents, currency, status, payer_name, payer_email, portal_payment_link_id
      ) VALUES (
        ${charge.companyId}, 'customer_invoice', ${charge.invoiceId},
        ${init.reference}, ${init.accessCode}, ${init.authorizationUrl},
        ${charge.chargeCents}, 'ZAR', 'pending', ${charge.clientName}, ${payerEmail}, ${charge.linkId}::UUID
      )
    `;

    return apiResponse.success(res, {
      checkoutUrl: init.authorizationUrl,
      reference: init.reference,
    });
  } catch (err) {
    log.error(
      'Failed to initialise Paystack transaction',
      { invoiceId: charge.invoiceId, err: err instanceof Error ? err.message : String(err) },
      'PaystackPortal',
    );
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
}

export default withErrorHandler(handler);
