/**
 * POST /api/cron/dunning-send
 *
 * Daily dunning walker. Protected by X-Cron-Secret.
 * PRD-06 Phase 5 — see dunningCronService.ts for gating logic.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runDunningCron } from '@/modules/accounting/services/ar/dunningCronService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-dunning');
    apiResponse.internalError(res, new Error('Cron secret not configured'));
    return;
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-dunning');
    apiResponse.unauthorized(res);
    return;
  }

  const started = Date.now();
  log.info('Cron triggered: dunning-send', {}, 'cron-dunning');

  const portalBaseUrl = process.env.PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  const result = await runDunningCron({ portalBaseUrl });
  const durationMs = Date.now() - started;

  log.info('Cron complete: dunning-send', { durationMs, ...result }, 'cron-dunning');
  apiResponse.success(res, { durationMs, ...result });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
