/**
 * Cron endpoint — daily budget-holder reminders (budgets P5 spec §3f; P5-6).
 *
 * For every active company with an open or returned slice of a draft budget version due within three
 * days (or overdue), in its own transaction: remind each holder in the bell at due −3 days, on the
 * due date and when overdue, once per slice per stage (sliceReminders.ts). In-app only; no email.
 * One company's failure is logged and the run goes on; the answer is then 500 (every company's
 * result in `error.details`) so the timer's curl --fail reports it.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var (timing-safe compare).
 * System-level endpoint — no withAuth; runs on the service pool's login (isaflow_service).
 * Triggered by scripts/isaflow-budget-reminders.timer (installing it on the server is an ops step).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runSliceReminderCron } from '@/modules/accounting/services/budgets/sliceReminders';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-budget-reminders');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-budget-reminders');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: budget reminders', {}, 'cron-budget-reminders');
  const result = await runSliceReminderCron();
  if (result.failed > 0) {
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, `Budget reminders: ${result.failed} of ${result.companies} companies failed`, result);
  }
  return apiResponse.success(res, result);
}

// NOTE: no withAuth — system-level cron endpoint
export default withErrorHandler(handler as never);
