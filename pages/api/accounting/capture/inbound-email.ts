/**
 * POST /api/accounting/capture/inbound-email
 * Postmark inbound webhook — no user auth (webhook).
 * Verifies X-Postmark-Token header if POSTMARK_INBOUND_TOKEN env var is set.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  ingestPostmarkPayload,
  type PostmarkInboundPayload,
} from '@/modules/accounting/services/capture/inboundEmailService';
import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  // Pentest M1: fail-closed token verification. Previously, a missing env var
  // silently skipped the check — any caller could POST arbitrary payloads and
  // trigger VLM routing. Now we reject if the secret isn't configured.
  const expectedToken = process.env.POSTMARK_INBOUND_TOKEN;
  if (!expectedToken) {
    log.error('POSTMARK_INBOUND_TOKEN not set — rejecting webhook', undefined, 'inbound-email');
    return res.status(503).json({ success: false, error: 'Webhook misconfigured' });
  }
  const provided = req.headers['x-postmark-token'];
  if (provided !== expectedToken) {
    log.warn('Postmark webhook: invalid token', undefined, 'inbound-email');
    return res.status(401).json({ success: false, error: 'Invalid webhook token' });
  }

  const payload = req.body as PostmarkInboundPayload;

  const result = await ingestPostmarkPayload(payload);

  if ('rejected' in result) {
    log.info('Postmark webhook: payload rejected', { reason: result.rejected }, 'inbound-email');
    // Return 200 so Postmark does not retry rejected messages
    return apiResponse.success(res, { rejected: result.rejected });
  }

  const { captureEventIds, companyId } = result;

  // Fire-and-forget VLM routing for each attachment (do not await — keep webhook fast)
  for (const eventId of captureEventIds) {
    routeEvent(eventId, companyId).catch((err: unknown) => {
      log.error('routeEvent background error', {
        captureEventId: eventId,
        error: err instanceof Error ? err.message : String(err),
      }, 'inbound-email');
    });
  }

  return apiResponse.success(res, { captureEventIds, companyId });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
