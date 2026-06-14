/**
 * Cron — monthly reset of PAYG Flow counters.
 *
 * Cadence: first of each month at 00:05 SAST (see timer in
 * scripts/isaflow-flow-month-reset.timer).  Resets `month_flows_used`
 * and `nudge_level` on every `flow_wallet` row.
 *
 * Auth: X-Cron-Secret header must match CRON_SECRET env var.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { resetMonthlyCounter } from '@/modules/billing/services/flowWalletService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-reset-flow-month');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-reset-flow-month');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  log.info('Cron triggered: reset-flow-month', {}, 'cron-reset-flow-month');

  const { companiesReset } = await resetMonthlyCounter();
  const durationMs = Date.now() - started;

  log.info('Monthly flow counters reset',
    { companiesReset, durationMs }, 'cron-reset-flow-month');

  return apiResponse.success(res, { success: true, companiesReset, durationMs });
}

export default withErrorHandler(handler);
