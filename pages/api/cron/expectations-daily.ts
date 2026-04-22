/**
 * Cron endpoint — daily supplier-expectation engine run.
 *
 * Does in sequence, per company:
 *   1. Recompute every supplier's cadence from recent invoices.
 *   2. Detect gaps (creates pending alerts for missing invoices).
 *   3. If company.chase_auto_send_enabled=true, auto-send chase emails for
 *      alerts older than chase_grace_days (supplier must have email + not
 *      be chase_opted_out).
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * System-level endpoint — no withAuth, no withCompany.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { runDailyExpectationCron } from '@/modules/accounting/services/capture/expectationCronService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-expectations-daily');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', {
      ip: req.socket.remoteAddress,
    }, 'cron-expectations-daily');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: daily expectations', {}, 'cron-expectations-daily');

  const result = await runDailyExpectationCron();
  return apiResponse.success(res, result);
}

export default withErrorHandler(handler as never);
