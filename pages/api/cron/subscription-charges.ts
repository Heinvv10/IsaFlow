/**
 * Cron — generates and runs subscription debits.
 *
 * Cadence: hourly. First pass generates queued rows for any subscriptions
 * whose period has ended; second pass submits queued/retry-eligible debits
 * to Stitch via the active LinkPay mandate.
 *
 * Auth: X-Cron-Secret header must match CRON_SECRET env var.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import {
  generateDueCharges,
  runQueuedCharges,
} from '@/modules/billing/services/subscriptionBillingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-subscription-charges');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-subscription-charges');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  log.info('Cron triggered: subscription-charges', {}, 'cron-subscription-charges');

  const generated = await generateDueCharges();
  const ran = await runQueuedCharges();
  const durationMs = Date.now() - started;

  log.info(
    'Cron complete: subscription-charges',
    { durationMs, ...generated, ...ran },
    'cron-subscription-charges',
  );
  return apiResponse.success(res, { durationMs, generated, ran });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
