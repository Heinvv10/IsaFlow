/**
 * POST /api/webhooks/paystack — Paystack event webhook.
 *
 * Auth: HMAC-SHA512 of the raw JSON body using PAYSTACK_SECRET_KEY,
 *       compared to the `x-paystack-signature` header (hex digest).
 * Idempotency: paystack_webhook_events.body_sha256 UNIQUE.
 *
 * Events we act on:
 *   charge.success            — once-off invoice / flow / auth-capture paid
 *   subscription.create       — recurring subscription set up
 *   subscription.disable      — subscription cancelled
 *   invoice.payment_failed    — recurring debit failed
 *   invoice.update            — usually maps to a successful recurring charge
 *
 * For everything else we record the event and ack with 200 — Paystack only
 * retries on non-2xx responses, so silent ack avoids storms while we still
 * have the raw payload in paystack_webhook_events for forensics.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { withErrorHandler } from '@/lib/api-error-handler';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  completeBundlePurchase,
  failBundlePurchase,
} from '@/modules/billing/services/flowWalletService';

export const config = { api: { bodyParser: false } };

function readRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function verifySignature(secret: string, rawBody: string, header: string): boolean {
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface PaystackWebhookEvent {
  event: string;
  data: {
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
    channel?: string;
    paid_at?: string;
    gateway_response?: string;
    id?: number;
    customer?: {
      email?: string;
      customer_code?: string;
    };
    authorization?: {
      authorization_code?: string;
      last4?: string;
      brand?: string;
      exp_month?: string;
      exp_year?: string;
      bank?: string;
      reusable?: boolean;
    };
    plan?: {
      plan_code?: string;
    };
    subscription_code?: string;
    email_token?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-paystack-signature'];
  const secret = process.env.PAYSTACK_SECRET_KEY;

  if (typeof signature !== 'string' || !signature) {
    return res.status(400).json({ error: 'Missing x-paystack-signature' });
  }
  if (!secret) {
    log.error('PAYSTACK_SECRET_KEY missing', {}, 'PaystackWebhook');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  if (!verifySignature(secret, rawBody, signature)) {
    log.warn('Paystack webhook signature verification failed', {}, 'PaystackWebhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const bodyHash = createHash('sha256').update(rawBody).digest('hex');

  let event: PaystackWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PaystackWebhookEvent;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const eventType = event.event ?? 'unknown';
  const reference = event.data?.reference ?? null;

  // Idempotency — duplicate redeliveries return 200 without re-processing.
  const existing = await sql<{ id: string }>`
    SELECT id FROM paystack_webhook_events WHERE body_sha256 = ${bodyHash} LIMIT 1
  `;
  if (existing[0]) return res.status(200).json({ duplicate: true });

  const logRows = await sql<{ id: string }>`
    INSERT INTO paystack_webhook_events (body_sha256, event_type, reference, payload)
    VALUES (${bodyHash}, ${eventType}, ${reference}, ${event as unknown as string}::jsonb)
    RETURNING id
  `;
  const eventLogId = logRows[0]?.id;
  if (!eventLogId) {
    return res.status(500).json({ error: 'Failed to persist webhook event' });
  }

  try {
    await processEvent(eventType, event);
    await sql`
      UPDATE paystack_webhook_events
      SET processed = TRUE, processed_at = now()
      WHERE id = ${eventLogId}
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Paystack webhook processing failed', { eventLogId, msg }, 'PaystackWebhook');
    await sql`
      UPDATE paystack_webhook_events
      SET processing_error = ${msg}
      WHERE id = ${eventLogId}
    `;
    return res.status(500).json({ error: 'Processing failed' });
  }
}

async function processEvent(
  eventType: string,
  event: PaystackWebhookEvent,
): Promise<void> {
  const data = event.data ?? {};
  const reference = data.reference;

  if (eventType === 'charge.success') {
    if (!reference) return;
    await handleChargeSuccess(reference, event);
    return;
  }

  if (
    eventType === 'charge.failed' ||
    eventType === 'invoice.payment_failed'
  ) {
    if (reference) await handleChargeFailed(reference, eventType);
    return;
  }

  if (eventType === 'subscription.disable') {
    const subCode = (data.subscription_code as string | undefined) ?? null;
    if (subCode) await handleSubscriptionDisabled(subCode);
    return;
  }

  // subscription.create / invoice.create / invoice.update — informational.
  log.info('Paystack event recorded (no-op handler)', { eventType }, 'PaystackWebhook');
}

async function handleChargeSuccess(
  reference: string,
  event: PaystackWebhookEvent,
): Promise<void> {
  const auth = event.data.authorization ?? {};
  const customer = event.data.customer ?? {};

  const prRows = await sql<{
    id: string;
    company_id: string;
    purpose: string;
    customer_invoice_id: string | null;
    flow_purchase_id: string | null;
    subscription_charge_id: string | null;
    amount_cents: string;
    status: string;
  }>`
    UPDATE paystack_payment_requests
    SET status = 'completed',
        completed_at = COALESCE(completed_at, now()),
        paystack_transaction_id = ${event.data.id ?? null},
        paystack_authorization_code = COALESCE(${auth.authorization_code ?? null}, paystack_authorization_code),
        paystack_customer_code = COALESCE(${customer.customer_code ?? null}, paystack_customer_code),
        channel = COALESCE(${event.data.channel ?? null}, channel)
    WHERE paystack_reference = ${reference}
      AND status <> 'completed'
    RETURNING id, company_id, purpose, customer_invoice_id, flow_purchase_id, subscription_charge_id, amount_cents, status
  `;
  const pr = prRows[0];
  if (!pr) {
    log.info(
      'charge.success — no matching payment request (possible duplicate or out-of-band)',
      { reference },
      'PaystackWebhook',
    );
    return;
  }

  if (pr.purpose === 'customer_invoice' && pr.customer_invoice_id) {
    const amountRand = Number(pr.amount_cents) / 100;
    await sql`
      UPDATE customer_invoices
      SET amount_paid = LEAST(total_amount, COALESCE(amount_paid, 0) + ${amountRand}),
          status = CASE
            WHEN COALESCE(amount_paid, 0) + ${amountRand} >= total_amount THEN 'paid'
            ELSE status
          END,
          updated_at = now()
      WHERE id = ${pr.customer_invoice_id} AND company_id = ${pr.company_id}
    `;
    return;
  }

  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    await completeBundlePurchase(pr.flow_purchase_id);
    log.info(
      'flow bundle credited via Paystack webhook',
      { purchaseId: pr.flow_purchase_id, companyId: pr.company_id },
      'PaystackWebhook',
    );
    return;
  }

  if (pr.purpose === 'authorization' && auth.authorization_code) {
    // Auth capture — promote the captured authorization onto the company's
    // mandate row so subsequent recurring debits can charge it.
    await sql`
      UPDATE subscription_mandates
      SET status = 'active',
          gateway = 'paystack',
          paystack_authorization_code = ${auth.authorization_code},
          paystack_customer_code = ${customer.customer_code ?? null},
          card_last4 = ${auth.last4 ?? null},
          card_brand = ${auth.brand ?? null},
          card_exp_month = ${auth.exp_month ?? null},
          card_exp_year = ${auth.exp_year ?? null},
          bank_name = COALESCE(${auth.bank ?? null}, bank_name),
          authorised_at = COALESCE(authorised_at, now()),
          updated_at = now()
      WHERE company_id = ${pr.company_id} AND status IN ('pending','active')
    `;
    return;
  }

  if (pr.purpose === 'subscription_charge' && pr.subscription_charge_id) {
    await sql`
      UPDATE subscription_charges
      SET status = 'settled',
          settled_at = COALESCE(settled_at, now()),
          updated_at = now()
      WHERE id = ${pr.subscription_charge_id} AND company_id = ${pr.company_id}
    `;
  }
}

async function handleChargeFailed(reference: string, reason: string): Promise<void> {
  const prRows = await sql<{
    id: string;
    purpose: string;
    flow_purchase_id: string | null;
    subscription_charge_id: string | null;
  }>`
    UPDATE paystack_payment_requests
    SET status = 'failed',
        failure_reason = ${reason}
    WHERE paystack_reference = ${reference}
      AND status NOT IN ('completed','failed')
    RETURNING id, purpose, flow_purchase_id, subscription_charge_id
  `;
  const pr = prRows[0];
  if (!pr) return;

  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    await failBundlePurchase(pr.flow_purchase_id, reason);
  }
  if (pr.purpose === 'subscription_charge' && pr.subscription_charge_id) {
    await sql`
      UPDATE subscription_charges
      SET status = 'failed',
          failure_reason = ${reason},
          attempt_count = attempt_count + 1,
          last_attempt_at = now(),
          updated_at = now()
      WHERE id = ${pr.subscription_charge_id}
    `;
  }
}

async function handleSubscriptionDisabled(subscriptionCode: string): Promise<void> {
  await sql`
    UPDATE subscription_mandates
    SET status = 'revoked',
        revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = 'paystack_subscription_disabled',
        updated_at = now()
    WHERE paystack_subscription_code = ${subscriptionCode}
      AND status NOT IN ('revoked','expired')
  `;
}

export default withErrorHandler(handler);
