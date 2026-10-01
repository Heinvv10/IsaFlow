import { verifyWhatsAppDestination } from '@/modules/accounting/services/capture/whatsAppVerificationService';
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
    // Signature verification needs the exact public URL Twilio called.
    // Without a configured base URL every legitimate webhook would 403 as
    // "invalid signature" (terminal for Twilio — the message is lost), so a
    // missing URL fails closed as a config error instead: 503, Twilio retries.
    const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      log.error(
        'APP_URL/NEXT_PUBLIC_APP_URL not set — cannot verify Twilio signature; rejecting inbound WhatsApp webhook',
        undefined,
        'whatsapp-inbound',
      );
      return res.status(503).json({ success: false, error: 'Webhook verification not configured' });
    }

    // Lazy-import twilio to avoid hard startup dep when env not configured

    // twilio is CJS: under webpack's ESM interop the static helpers live on
    // .default, not the namespace (the reply service calls twilioMod.default()
    // for the same reason). Fall back across both shapes, fail closed if absent.
    type ValidateRequestFn = (
      authToken: string,
      signature: string,
      url: string,
      params: Record<string, string>,
    ) => boolean;
    const twilioLib = (await import('twilio')) as unknown as {
      validateRequest?: ValidateRequestFn;
      default?: { validateRequest?: ValidateRequestFn };
    };
    const validateRequest =
      twilioLib.validateRequest ?? twilioLib.default?.validateRequest;
    if (typeof validateRequest !== 'function') {
      log.error(
        'twilio.validateRequest unavailable — cannot verify webhook signature; rejecting',
        undefined,
        'whatsapp-inbound',
      );
      return res.status(503).json({ success: false, error: 'Webhook verification not configured' });
    }

    const signature =
      (req.headers['x-twilio-signature'] as string | undefined) ?? '';

    const webhookUrl = `${appUrl.replace(/\/$/, '')}${req.url ?? '/api/accounting/capture/inbound/whatsapp'}`;

    const params = (req.body ?? {}) as Record<string, string>;
    const valid = validateRequest(authToken, signature, webhookUrl, params);

    if (!valid) {
      log.warn(
        'Twilio webhook: invalid signature',
        undefined,
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
  // A signature also authenticates outbound status callbacks. Those cannot prove
  // control of the recipient's incoming-message webhook. Inspect signed BODY only.
  const incoming = typeof payload.From === 'string' && /^whatsapp:\+\d{7,15}$/.test(payload.From)
    && typeof payload.To === 'string' && /^whatsapp:\+\d{7,15}$/.test(payload.To)
    && typeof payload.Body === 'string' && typeof payload.NumMedia === 'string'
    && /^\d+$/.test(payload.NumMedia) && typeof payload.WaId === 'string'
    && payload.WaId === payload.From.slice('whatsapp:+'.length)
    && [payload.MessageStatus, payload.SmsStatus].every(status => status === undefined || status === 'received');
  if (!incoming) return apiResponse.success(res, { rejected: 'destination verification required' });

  const callbackUrl = new URL(req.url ?? '', 'http://localhost');
  const tokens = callbackUrl.searchParams.getAll('token');
  const token = tokens.length === 1 ? tokens[0]! : '';
  const binding = await verifyWhatsAppDestination(token, (payload.To ?? '').replace(/^whatsapp:/i, '').trim());
  if (!binding) return apiResponse.success(res, { rejected: 'destination verification required' });
  const result = await ingestTwilioPayload(payload, binding);

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
