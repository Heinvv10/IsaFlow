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
import { withPublicRouteTransaction } from '@/lib/publicRouteTx';
import { log } from '@/lib/logger';
import {
  processEvent,
  type PaystackWebhookEvent,
} from '@/modules/billing/services/paystackEventHandlers';

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

/** Free-form label of which Paystack integration is configured. Tagged on
 *  webhook log lines so concurrent dev/staging integrations are easy to
 *  disambiguate in Sentry/Bugsink. */
function integrationName(): string {
  return process.env.PAYSTACK_INTEGRATION_NAME?.trim() || 'unset';
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
    log.warn('Paystack webhook signature verification failed', { integration: integrationName() }, 'PaystackWebhook');
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

  // The event row is written on the pool (outside the processing transaction)
  // so the raw payload and any processing_error survive a rollback. ON CONFLICT
  // makes the insert safe against two concurrent redeliveries of one body.
  const inserted = await sql<{ id: string; processed: boolean }>`
    INSERT INTO paystack_webhook_events (body_sha256, event_type, reference, payload)
    VALUES (${bodyHash}, ${eventType}, ${reference}, ${event as unknown as string}::jsonb)
    ON CONFLICT (body_sha256) DO NOTHING
    RETURNING id, processed
  `;
  let record = inserted[0];
  if (!record) {
    const existing = await sql<{ id: string; processed: boolean }>`
      SELECT id, processed FROM paystack_webhook_events WHERE body_sha256 = ${bodyHash} LIMIT 1
    `;
    record = existing[0];
    // Only a SUCCESSFULLY processed event may be acked as a duplicate. An
    // earlier delivery that threw left processed = FALSE and rolled its writes
    // back, so Paystack's redelivery must be processed rather than discarded.
    if (record?.processed) return res.status(200).json({ duplicate: true });
  }
  const eventLogId = record?.id;
  if (!eventLogId) {
    return res.status(500).json({ error: 'Failed to persist webhook event' });
  }

  try {
    await processEventInTransaction(eventLogId, eventType, event);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Paystack webhook processing failed', { integration: integrationName(), eventLogId, msg }, 'PaystackWebhook');
    await sql`
      UPDATE paystack_webhook_events
      SET processing_error = ${msg}
      WHERE id = ${eventLogId}
    `;
    return res.status(500).json({ error: 'Processing failed' });
  }
}

/**
 * Run the event handlers and the processed stamp in ONE transaction on an
 * ALS-bound client, so every `sql` call they make joins it. A throw rolls the
 * whole event back — including the `paystack_payment_requests` status change —
 * leaving the row states that let Paystack's redelivery reprocess it.
 */
async function processEventInTransaction(
  eventLogId: string,
  eventType: string,
  event: PaystackWebhookEvent,
): Promise<void> {
  await withPublicRouteTransaction('paystack-webhook', async () => {
    await processEvent(eventType, event);
    await sql`
      UPDATE paystack_webhook_events
      SET processed = TRUE, processed_at = now()
      WHERE id = ${eventLogId}
    `;
  });
}

export default withErrorHandler(handler);
