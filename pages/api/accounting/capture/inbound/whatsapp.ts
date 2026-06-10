/**
 * POST /api/accounting/capture/inbound/whatsapp
 * Twilio WABA inbound webhook.
 * Verifies X-Twilio-Signature when TWILIO_AUTH_TOKEN is set.
 * Responses:
 *  - 403 on invalid signature (4xx is terminal for Twilio — no retry)
 *  - 503 when TWILIO_AUTH_TOKEN is unconfigured (fail closed; Twilio retries
 *    5xx — intentional, the deployment must be fixed)
 *  - 200 otherwise, including rejected payloads, so Twilio does not retry
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  ingestTwilioPayload,
  type TwilioInboundPayload,
} from '@/modules/accounting/services/capture/whatsAppInboundService';
import { sendWhatsAppMessage } from '@/modules/accounting/services/capture/whatsAppReplyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  // ─── Twilio signature verification ─────────────────────────────────────────
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    // Lazy-import twilio to avoid hard startup dep when env not configured
     
    const twilioLib = await import('twilio');
    const validateRequest: (
      authToken: string,
      signature: string,
      url: string,
      params: Record<string, string>,
    ) => boolean = twilioLib.validateRequest;

    const signature =
      (req.headers['x-twilio-signature'] as string | undefined) ?? '';

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const webhookUrl = `${appUrl}/api/accounting/capture/inbound/whatsapp`;

    const params = (req.body ?? {}) as Record<string, string>;
    const valid = validateRequest(authToken, signature, webhookUrl, params);

    if (!valid) {
      log.warn(
        'Twilio webhook: invalid signature',
        { signature },
        'whatsapp-inbound',
      );
      // Return 403 — Twilio will retry only on 5xx; 4xx is terminal for the message
      return res.status(403).json({ success: false, error: 'Invalid Twilio signature' });
    }
  } else {
    // Fail closed, same as the Postmark inbound route: an unconfigured
    // deployment must not accept unauthenticated capture events.
    log.error('TWILIO_AUTH_TOKEN not set — rejecting inbound WhatsApp webhook', undefined, 'whatsapp-inbound');
    return res.status(503).json({ success: false, error: 'Webhook verification not configured' });
  }

  const payload = req.body as TwilioInboundPayload;
  const from = payload.From ?? '';

  const result = await ingestTwilioPayload(payload);

  if ('rejected' in result) {
    log.info(
      'Twilio webhook: payload rejected',
      { reason: result.rejected },
      'whatsapp-inbound',
    );
    // Return 200 so Twilio does not retry rejected messages
    return apiResponse.success(res, { rejected: result.rejected });
  }

  const { captureEventIds, companyId, parsedCommand } = result;
  const numMedia = parseInt(payload.NumMedia ?? '0', 10);

  // ─── Outbound acknowledgement ───────────────────────────────────────────────
  if (numMedia > 0 && captureEventIds.length > 0) {
    const replyBody =
      captureEventIds.length === 1
        ? 'Received 1 photo — extracting now. I\'ll confirm once posted.'
        : `Received ${captureEventIds.length} photo(s) — extracting now. I'll confirm once posted.`;

    sendWhatsAppMessage(from, replyBody).catch((err: unknown) => {
      log.warn('whatsapp webhook: reply failed', {
        to: from,
        error: err instanceof Error ? err.message : String(err),
      }, 'whatsapp-inbound');
    });
  } else if (parsedCommand) {
    // Phase 8 scope: text-only command — acknowledge, defer JE posting to Phase 9
    sendWhatsAppMessage(
      from,
      "Got it — working on extracting your expense, I'll send a confirmation shortly.",
    ).catch((err: unknown) => {
      log.warn('whatsapp webhook: reply failed', {
        to: from,
        error: err instanceof Error ? err.message : String(err),
      }, 'whatsapp-inbound');
    });
  }

  log.info('Twilio webhook: processed', {
    companyId, captureEventIds, hasCommand: !!parsedCommand,
  }, 'whatsapp-inbound');

  return apiResponse.success(res, {
    captureEventIds,
    companyId,
    parsedCommand,
  });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
