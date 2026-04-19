// pages/api/cron/practice/daily-reminders.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { runDailyDigest } from '@/modules/accounting/services/practice/practiceNotificationService';

/**
 * Cron endpoint — sends daily digest emails per assignee:
 *   - Overdue practice tasks
 *   - Missing timesheet for yesterday (weekdays only)
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * System-level endpoint — no withAuth, no withCompany.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-practice-daily-reminders');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-practice-daily-reminders');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: practice daily digest', {}, 'cron-practice-daily-reminders');

  const result = await runDailyDigest();
  return apiResponse.success(res, result);
}

// NOTE: no withAuth — system-level cron endpoint
export default withErrorHandler(handler as never);
