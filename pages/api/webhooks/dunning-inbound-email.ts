/**
 * POST /api/webhooks/dunning-inbound-email
 *
 * Generic inbound-email bridge for dunning response tracking. Accepts:
 *   { from, subject, body_plain, body_html, text }
 *
 * Extracts [ref:TOKEN] from the body, infers response_action from
 * keywords, records onto dunning_sends.
 *
 * Tie to any inbound-parse provider (SendGrid Inbound Parse, Mailgun
 * Routes, Postmark, Zapier email trigger) — they can all POST this shape.
 *
 * Security: optional X-Webhook-Secret (DUNNING_WEBHOOK_SECRET env var).
 * Matched message tokens are UUIDv4, so brute-force is infeasible even
 * without the secret layer.
 *
 * PRD-06 Phase 5 follow-up.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  processInboundEmail,
  type InboundEmailPayload,
} from '@/modules/accounting/services/ar/dunningInboundParseService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  // Pentest L18: fail-closed secret verification.
  const expectedSecret = process.env.DUNNING_WEBHOOK_SECRET;
  if (!expectedSecret) {
    log.error('DUNNING_WEBHOOK_SECRET not set — rejecting webhook', undefined, 'dunning-inbound');
    res.status(503).json({ success: false, error: { code: 'WEBHOOK_MISCONFIGURED', message: 'Webhook misconfigured' } });
    return;
  }
  if (req.headers['x-webhook-secret'] !== expectedSecret) {
    log.warn('dunning-inbound-email unauthorized', {
      ip: req.socket.remoteAddress,
    }, 'dunning-inbound');
    apiResponse.unauthorized(res);
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload: InboundEmailPayload = {
    from: typeof body.from === 'string' ? body.from : undefined,
    subject: typeof body.subject === 'string' ? body.subject : undefined,
    body_plain: typeof body.body_plain === 'string' ? body.body_plain : undefined,
    body_html: typeof body.body_html === 'string' ? body.body_html : undefined,
    text: typeof body.text === 'string' ? body.text : undefined,
  };

  const result = await processInboundEmail(payload);
  // Always 200 — silent "we couldn't match" is useful for provider retry
  // logic. The response body tells ops what happened.
  apiResponse.success(res, result);
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
