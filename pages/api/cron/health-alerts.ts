/**
 * Cron endpoint — admin health alerts (admin audit OP-1).
 *
 * Takes the same system-health snapshot as GET /api/admin/health, on the
 * platform_admin pool, and hands it to the same checkAndAlert, so a degraded or
 * critical system alerts without an admin having /admin/health open. The alert
 * debounce (status change, else once an hour) is claimed under an advisory lock
 * before sending (healthAlertState.ts), so this pass and an open Health tab never
 * both send one change. A snapshot that cannot be taken, or an alert that reached
 * no channel, is a 500 (the timer's curl --fail reports it) and the run is not
 * recorded; a successful pass records the time the Health page shows.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * System-level endpoint — no withAuth.
 * Triggered every 5 minutes by scripts/isaflow-health-alerts.timer (installing it on the server is an ops step).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runScheduledHealthAlert } from '@/modules/admin/services/healthAlertRun';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-health-alerts');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-health-alerts');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: health alerts', {}, 'cron-health-alerts');
  const overall_status = await runScheduledHealthAlert();
  log.info('Cron complete: health alerts', { overall_status }, 'cron-health-alerts');
  return apiResponse.success(res, { overall_status });
}

// NOTE: no withAuth — system-level cron endpoint
export default withErrorHandler(handler as never);
