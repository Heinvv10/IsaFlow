/**
 * PayFast ITN (Instant Transaction Notification) Webhook
 * POST — called by PayFast servers to confirm payment status
 *
 * NO auth wrapper — this is a public webhook endpoint.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { handleITN } from '@/modules/accounting/services/paymentGatewayService';
import { log } from '@/lib/logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get source IP from request (may be behind proxy)
    const sourceIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || '';

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
