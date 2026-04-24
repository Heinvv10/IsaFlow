/**
 * POST /api/webhooks/stitch — Svix-delivered Stitch Express webhook events.
 *
 * Stitch Express (as of 2026-04) only emits two event types:
 *   - `payment.paid`    — payment flow completed (funds NOT yet settled)
 *   - `payment.settled` — funds confirmed received  (NOT YET AVAILABLE — may never fire)
 *
 * Per product decision: on `payment.paid` we optimistically mark the invoice
 * as paid (matches our existing PayFast parity). `payment.settled` is still
 * logged, but its arrival is best-effort — if Stitch never turns it on we
 * don't block the ledger.
 *
 * Auth: Svix HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`
 * signed with the base64 webhook secret (format: whsec_<base64>).
 * Idempotency: stitch_webhook_events.svix_id UNIQUE.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { createHmac, timingSafeEqual } from 'crypto';
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

function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: string,
  svixSignature: string,
): boolean {
  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'base64');

  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', secretBytes).update(signed).digest('base64');

  for (const part of svixSignature.split(' ')) {
    const [, sig] = part.split(',');
    if (!sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Stitch Express webhook payload (Svix-wrapped).
 *
 * Example (from the Stitch webhooks Testing tab — `payment.paid`):
 *   {
 *     "type": "payment.paid",
 *     "data": {
 *       "id": "5A26F599-...",          // payment id (NOT the payment-link id)
 *       "status": "PAID",
 *       "type": "LINK" | "SUBSCRIPTION" | "CONSENT",
 *       "amount": 1886,                 // cents
 *       "linkId": "hxvse6...",          // present when data.type === 'LINK'
 *       "subscriptionId": "...",        // present when data.type === 'SUBSCRIPTION'
 *       "consentId": "..."              // present when data.type === 'CONSENT'
 *     }
 *   }
 *
 * Stitch does NOT echo `externalReference` in the webhook body, so we
 * correlate on `data.linkId` (stored as `stitch_payment_requests.stitch_payment_id`).
 */
interface StitchExpressEvent {
  type?: string;
  eventType?: string;
  data?: {
    id?: string;
    status?: string;
    type?: 'LINK' | 'SUBSCRIPTION' | 'CONSENT' | string;
    amount?: number;
    linkId?: string;
    subscriptionId?: string;
    consentId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const svixId = req.headers['svix-id'] as string | undefined;
  const svixTimestamp = req.headers['svix-timestamp'] as string | undefined;
  const svixSignature = req.headers['svix-signature'] as string | undefined;
  const secret = process.env.STITCH_WEBHOOK_SECRET;

  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: 'Missing Svix headers' });
  }
  if (!secret) {
    log.error('STITCH_WEBHOOK_SECRET missing', {}, 'StitchWebhook');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  if (!verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature)) {
    log.warn('Stitch webhook signature verification failed', { svixId }, 'StitchWebhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody) as StitchExpressEvent;
  const eventType = (event.type ?? event.eventType ?? 'unknown') as string;

  const existing = await sql<{ id: string; processed: boolean }>`
    SELECT id, processed FROM stitch_webhook_events WHERE svix_id = ${svixId} LIMIT 1
  `;
  if (existing[0]) return res.status(200).json({ duplicate: true });

  const logRows = await sql<{ id: string }>`
    INSERT INTO stitch_webhook_events (svix_id, event_type, payload)
    VALUES (${svixId}, ${eventType}, ${event as unknown as string}::jsonb)
    RETURNING id
  `;
  const eventLogId = logRows[0]?.id;
  if (!eventLogId) {
    return res.status(500).json({ error: 'Failed to persist webhook event' });
  }

  try {
    await processEvent(eventType, event);
    await sql`
      UPDATE stitch_webhook_events
      SET processed = TRUE, processed_at = now()
      WHERE id = ${eventLogId}
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Stitch webhook processing failed', { eventLogId, msg }, 'StitchWebhook');
    await sql`
      UPDATE stitch_webhook_events
      SET processing_error = ${msg}
      WHERE id = ${eventLogId}
    `;
    return res.status(500).json({ error: 'Processing failed' });
  }
}

async function processEvent(eventType: string, event: StitchExpressEvent): Promise<void> {
  const data = event.data ?? {};
  // Stitch's LINK payments populate `data.linkId` — that's the value we
  // persisted as `stitch_payment_id` when creating the payment link.
  // For SUBSCRIPTION/CONSENT payments we fall back to the payment id itself.
  const correlationId = data.linkId ?? data.subscriptionId ?? data.consentId ?? data.id;
  const paymentId = data.id;

  if (!correlationId) {
    log.info('Stitch webhook has no correlation id', { eventType }, 'StitchWebhook');
    return;
  }

  if (eventType === 'payment.paid') {
    await handlePaymentPaid(correlationId, paymentId);
    return;
  }

  if (eventType === 'payment.settled') {
    await handlePaymentSettled(correlationId, paymentId);
    return;
  }

  if (
    eventType === 'payment.failed' ||
    eventType === 'payment.cancelled' ||
    eventType === 'payment.expired'
  ) {
    await handlePaymentFailed(correlationId, eventType);
    return;
  }

  log.info('Unhandled Stitch event type (logged only)', { eventType }, 'StitchWebhook');
}

async function handlePaymentFailed(
  correlationId: string,
  reason: string,
): Promise<void> {
  const prRows = await sql<{
    id: string;
    purpose: string;
    flow_purchase_id: string | null;
  }>`
    UPDATE stitch_payment_requests
    SET status = 'failed'
    WHERE stitch_payment_id = ${correlationId}
      AND status NOT IN ('completed', 'settled', 'failed')
    RETURNING id, purpose, flow_purchase_id
  `;
  const pr = prRows[0];
  if (!pr) return;
  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    await failBundlePurchase(pr.flow_purchase_id, reason);
  }
}

async function handlePaymentPaid(
  correlationId: string,
  paymentId: string | undefined,
): Promise<void> {
  const prRows = await sql<{
    id: string;
    purpose: string;
    company_id: string;
    customer_invoice_id: string | null;
    flow_purchase_id: string | null;
    amount_cents: string;
    status: string;
  }>`
    UPDATE stitch_payment_requests
    SET status = 'completed',
        completed_at = COALESCE(completed_at, now())
    WHERE stitch_payment_id = ${correlationId}
      AND status <> 'completed'
    RETURNING id, purpose, company_id, customer_invoice_id, flow_purchase_id, amount_cents, status
  `;
  const pr = prRows[0];
  if (!pr) {
    log.info(
      'payment.paid — no matching payment request (possible duplicate)',
      { correlationId, paymentId },
      'StitchWebhook',
    );
    return;
  }

  if (pr.purpose === 'customer_invoice' && pr.customer_invoice_id) {
    const amountRand = Number(pr.amount_cents) / 100;
    await sql`
      UPDATE customer_invoices
      SET amount_paid = LEAST(total, COALESCE(amount_paid, 0) + ${amountRand}),
          status = CASE
            WHEN COALESCE(amount_paid, 0) + ${amountRand} >= total THEN 'paid'
            ELSE status
          END,
          updated_at = now()
      WHERE id = ${pr.customer_invoice_id} AND company_id = ${pr.company_id}
    `;
    return;
  }

  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    // Idempotent — re-deliveries land on an already-succeeded row and no-op.
    await completeBundlePurchase(pr.flow_purchase_id);
    log.info('flow bundle credited via Stitch webhook', {
      purchaseId: pr.flow_purchase_id,
      companyId: pr.company_id,
    }, 'StitchWebhook');
  }
}

async function handlePaymentSettled(
  correlationId: string,
  _paymentId: string | undefined,
): Promise<void> {
  // Settlement is informational — the invoice has already been marked paid
  // on payment.paid. We just record the settlement timestamp for audit.
  await sql`
    UPDATE stitch_payment_requests
    SET status = 'settled'
    WHERE stitch_payment_id = ${correlationId}
      AND status IN ('pending', 'completed')
  `;
}

export default withErrorHandler(handler);
