/**
 * PayFast ITN (Instant Transaction Notification) Webhook
 * POST — called by PayFast servers to confirm payment status
 *
 * NO auth wrapper — this is a public webhook endpoint.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { handleITN } from '@/modules/accounting/services/core/paymentGatewayService';
import { getClientIp } from '@/lib/rateLimit';
import { log } from '@/lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    // PayFast ITN webhook: response shape pinned by PayFast spec (must be the raw
    // literal; do NOT use apiResponse helpers). See https://developers.payfast.co.za/
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sourceIp = getClientIp(req);

    log.info('ITN received', { sourceIp, body: req.body }, 'PaymentGateway');

    const result = await handleITN(req.body || {}, sourceIp);

    if (!result.valid) {
      log.error('ITN validation failed', { transactionId: result.transactionId }, 'PaymentGateway');
      // PayFast expects 200 OK even on validation failure to stop retries
      return res.status(200).json({ status: 'invalid' });
    }

    log.info('ITN processed successfully', { transactionId: result.transactionId }, 'PaymentGateway');
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    log.error('ITN processing error', error instanceof Error ? { message: error.message, stack: error.stack } : { error }, 'PaymentGateway');
    // Return 200 to prevent PayFast from retrying indefinitely
    return res.status(200).json({ status: 'error' });
  }
}

// Public webhook — no auth required, but wrapped for consistent error handling.
// The res.status(200) responses inside the handler are intentional: PayFast
// requires 200 OK to stop retrying, even when validation fails.
export default withErrorHandler(handler);
