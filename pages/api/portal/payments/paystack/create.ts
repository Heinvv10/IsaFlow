/**
 * POST /api/portal/payments/paystack/create
 * Public (portal) — initialise a Paystack transaction for a customer invoice
 * via a signed portal token. Returns the hosted-checkout URL the browser
 * redirects to, plus the reference we'll use to verify on return.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { createHash, randomBytes } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { initializeTransaction } from '@/modules/billing/services/paystackClient';
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  checkoutFailed, checkoutStarted, existingCheckout, lockPaymentLink, recordStartingCheckout, resolveLinkCharge,
  type LinkCharge, type LinkChargeRefusal,
} from '@/modules/accounting/services/ar/portalLinkCharge';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { token } = (req.body ?? {}) as { token?: string };
  if (!token || typeof token !== 'string') {
    return apiResponse.badRequest(res, 'Missing portal token');
  }

  // Public and unauthenticated: bound how often one address, or one link, can start checkouts.
  const tokenKey = createHash('sha256').update(token).digest('hex').slice(0, 32);
  if (!(await checkRateLimit(`paystack-create:${getClientIp(req)}`, { max: 60, windowSecs: 900 }))
    || !(await checkRateLimit(`paystack-create-link:${tokenKey}`, { max: 20, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many payment attempts. Please wait and retry.');
  }

  // R-167, phase 1: a short transaction with the link row locked, so two clicks cannot both start
  // a checkout. It records the new checkout before the gateway is called and COMMITs; no
  // connection or lock is held across the gateway call.
  const claim = await withPublicRouteTransaction('paystack-create', () => claimCheckout(token));
  switch (claim.kind) {
    case 'link_not_found': return apiResponse.notFound(res, 'Payment link');
    case 'link_not_active': return apiResponse.badRequest(res, 'Payment link not active');
    case 'link_expired': return apiResponse.badRequest(res, 'Payment link expired');
    case 'invoice_gone': return apiResponse.notFound(res, 'Invoice');
    case 'nothing_owed': return apiResponse.badRequest(res, 'Invoice already paid');
    case 'starting': return apiResponse.conflict(res, 'Your payment is being set up. Please retry in a moment.');
    case 'reuse': return apiResponse.success(res, { checkoutUrl: claim.checkoutUrl, reference: claim.reference });
    case 'start': break;
  }

  // Phase 2: the gateway, outside any transaction and bounded in time.
  const { charge, reference, payerEmail } = claim;
  const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/portal/payments/paystack/return?ref=${encodeURIComponent(reference)}`;
  let init: Awaited<ReturnType<typeof initializeTransaction>>;
  try {
    init = await initializeTransaction({
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
      timeoutMs: GATEWAY_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Failed to initialise Paystack transaction', { invoiceId: charge.invoiceId, err: message }, 'PaystackPortal');
    await checkoutFailed(charge.companyId, reference, `initialise failed: ${message}`.slice(0, 500));
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }

  // Phase 3: where the customer pays it — unless the recorded checkout was swept as abandoned while
  // this request stalled, in which case its URL is never handed out.
  if (!(await checkoutStarted(charge.companyId, reference, init.accessCode, init.authorizationUrl))) {
    log.error('Paystack checkout no longer pending when its URL arrived', { invoiceId: charge.invoiceId, reference }, 'PaystackPortal');
    return apiResponse.internalError(res, 'Failed to initialise payment');
  }
  return apiResponse.success(res, { checkoutUrl: init.authorizationUrl, reference });
}

/** Bound on the gateway call; the checkout is recorded, so a slow gateway holds nothing else. */
const GATEWAY_TIMEOUT_MS = 10_000;

type Claim =
  | { kind: LinkChargeRefusal | 'starting' }
  | { kind: 'reuse'; checkoutUrl: string; reference: string }
  | { kind: 'start'; charge: LinkCharge; reference: string; payerEmail: string };

async function claimCheckout(token: string): Promise<Claim> {
  await lockPaymentLink(token);
  // What the link may charge: its own amount capped at the balance, or the live balance for the
  // invoice's standing link (portalLinkCharge).
  const resolved = await resolveLinkCharge(token);
  if (!resolved.ok) return { kind: resolved.reason };
  const charge = resolved.charge;

  const existing = await existingCheckout(charge);
  if (existing.kind !== 'none') return existing;

  // Paystack requires a payer email. We fall back to a synthetic per-token
  // address so payment still works even if the customer has no email on file.
  const payerEmail =
    charge.clientEmail && charge.clientEmail.includes('@')
      ? charge.clientEmail
      : `portal+${token}@noreply.isaflow.co.za`;
  const reference = `inv_${charge.invoiceId.replace(/-/g, '').slice(0, 12)}_${randomBytes(6).toString('hex')}`;
  await recordStartingCheckout(charge, reference, payerEmail);
  return { kind: 'start', charge, reference, payerEmail };
}

export default withErrorHandler(handler);
