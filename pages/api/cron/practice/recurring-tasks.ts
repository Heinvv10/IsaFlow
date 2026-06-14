// pages/api/cron/practice/recurring-tasks.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { sweepRecurringTasks } from '@/modules/accounting/services/practice/practiceRecurringTaskService';

/**
 * Cron endpoint — generates next instances of all recurring practice tasks.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * This route does NOT use withAuth — it is a system-level endpoint
 * that processes multiple companies internally.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-recurring-tasks');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-recurring-tasks');
    return apiResponse.unauthorized(res);
  }

  log.info('Cron triggered: recurring task sweep', {}, 'cron-recurring-tasks');

  const result = await sweepRecurringTasks();
  return apiResponse.success(res, result);
}

// NOTE: no withAuth — system-level cron endpoint
export default withErrorHandler(handler as never);
