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

  // Token verification
  const expectedToken = process.env.POSTMARK_INBOUND_TOKEN;
  if (expectedToken) {
    const provided = req.headers['x-postmark-token'];
    if (provided !== expectedToken) {
      log.warn('Postmark webhook: invalid token', { provided }, 'inbound-email');
      return res.status(401).json({ success: false, error: 'Invalid webhook token' });
    }
  } else {
    log.warn('POSTMARK_INBOUND_TOKEN not set — skipping webhook token verification', undefined, 'inbound-email');
  }

  const payload = req.body as PostmarkInboundPayload;

  const result = await ingestPostmarkPayload(payload);

  if ('rejected' in result) {
    log.info('Postmark webhook: payload rejected', { reason: result.rejected }, 'inbound-email');
    // Return 200 so Postmark does not retry rejected messages
    return apiResponse.success(res, { rejected: result.rejected });
  }

  const { captureEventId, companyId } = result;

  // Fire-and-forget VLM routing (do not await — keep webhook fast)
  routeEvent(captureEventId, companyId).catch((err: unknown) => {
    log.error('routeEvent background error', {
      captureEventId,
      error: err instanceof Error ? err.message : String(err),
    }, 'inbound-email');
  });

  return apiResponse.success(res, { captureEventId, companyId });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
