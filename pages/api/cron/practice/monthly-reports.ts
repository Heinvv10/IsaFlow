// pages/api/cron/practice/monthly-reports.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { runMonthlyReports } from '@/modules/accounting/services/practice/practiceMonthlyReportService';

/**
 * Cron endpoint — sends monthly practice management report emails.
 * Run on the 1st of each month to report on the previous calendar month.
 * Optional body: { reportMonth?: 'YYYY-MM' } for manual backfill.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * System-level endpoint — no withAuth, no withCompany.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-practice-monthly-reports');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-practice-monthly-reports');
    return apiResponse.unauthorized(res);
  }

  const { reportMonth } = (req.body ?? {}) as { reportMonth?: string };

  log.info('Cron triggered: practice monthly reports', { reportMonth }, 'cron-practice-monthly-reports');

  const result = await runMonthlyReports(reportMonth);
  return apiResponse.success(res, result);
}

// NOTE: no withAuth — system-level cron endpoint
export default withErrorHandler(handler as never);
