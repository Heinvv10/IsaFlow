/**
 * Cron endpoint — nightly recompute of the shared merchant-pattern pool (learning loop PR 2, decision 6).
 *
 * Replaces shared_merchant_patterns from the coding of every pool-eligible company (sharedPoolJob.ts). Full
 * recompute, idempotent: safe to run any number of times; an opted-out bureau's clients drop out on the
 * next run. Runs on the pool role with no request context (no withAuth), as every cron route does.
 * Scheduled by scripts/isaflow-shared-merchant-pool.{service,timer} (not installed by deploy.sh).
 *
 * While the legal-review gate is off (MERCHANT_SHARING_ENABLED, merchantSharingGate.ts) the job reads and
 * writes nothing and this answers 200 with { skipped: true, reason: 'sharing_pending_legal_review' }, so the
 * nightly timer does not report a failure every night while sharing waits for legal.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runSharedPoolAggregation } from '@/modules/accounting/services/sharedPool/sharedPoolJob';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  if (!process.env.CRON_SECRET) {
    return apiResponse.internalError(res, new Error('CRON_SECRET not configured'));
  }
  if (!timingSafeEqualStr(String(req.headers['x-cron-secret'] ?? ''), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-shared-merchant-pool');
    return apiResponse.unauthorized(res);
  }
  log.info('Cron triggered: shared-merchant-pool', {}, 'cron-shared-merchant-pool');
  return apiResponse.success(res, await runSharedPoolAggregation());
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
