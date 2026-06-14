/**
 * Cron — rate-limit data cleanup (M14 / WS-2b).
 *
 * Deletes stale rate_limit_counters rows and expired/stale account_lockouts
 * rows. Active lockouts (locked_until >= NOW()) are never touched.
 *
 * Cadence: nightly (e.g. 03:00 SAST). Secured by CRON_SECRET header.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { cleanupRateLimitData } from '@/modules/admin/services/rateLimitCleanupService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-rate-limit-cleanup');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-rate-limit-cleanup');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  const result = await cleanupRateLimitData();
  const durationMs = Date.now() - started;

  log.info(
    'Cron complete: rate-limit-cleanup',
    { durationMs, ...result },
    'cron-rate-limit-cleanup',
  );

  return apiResponse.success(res, { ...result, durationMs });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
