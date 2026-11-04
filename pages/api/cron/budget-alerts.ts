/**
 * Cron endpoint — the daily budget overspend run (budgets P5 spec §3d, decision 9).
 *
 * For every active company with a primary budget version or an open alert, in its own transaction:
 * evaluate the overspend alerts as of today (SAST), notify owners and admins of each NEW crossing in
 * the bell and record "last evaluated". One company's failure is logged and the run goes on; the
 * answer is then 500 (every company's result in `error.details`) so the timer's curl --fail reports it.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * System-level endpoint — no withAuth; runs on the service pool's login (isaflow_service).
 * Triggered by scripts/isaflow-budget-alerts.timer (installing it on the server is an ops step).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runBudgetAlertCron } from '@/modules/accounting/services/budgets/budgetAlertCron';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-budget-alerts');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-budget-alerts');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: budget alerts', {}, 'cron-budget-alerts');
  const result = await runBudgetAlertCron();
  // Any company failing is a failed run for systemd (curl --fail): 500, with every company's result.
  if (result.failed > 0) {
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, `Budget alerts: ${result.failed} of ${result.companies} companies failed`, result);
  }
  return apiResponse.success(res, result);
}

// NOTE: no withAuth — system-level cron endpoint
export default withErrorHandler(handler as never);
