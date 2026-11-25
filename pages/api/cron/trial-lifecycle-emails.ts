/**
 * Cron endpoint: daily trial lifecycle emails (day 3 setup nudge, day 10 check-in, 5 days before the
 * end, trial ended), once per company per stage, latest due stage only
 * (src/modules/onboarding/services/trialLifecycle/runTrialLifecycleEmails.ts).
 *
 * Query: `dry_run=1` reports what would be sent and writes and sends nothing; `limit=N` caps the
 * companies handled (default 50, clamped 1..200). Real sends also need env
 * TRIAL_LIFECYCLE_EMAILS_ENABLED=1; without it every run is a dry run and the answer says so.
 * A run where any company failed answers 500 (every company's result in `error.details`) so the
 * timer's curl --fail reports it.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var (timing-safe compare).
 * System-level endpoint, no withAuth; runs on the service pool's login (isaflow_service).
 * Triggered by scripts/isaflow-trial-lifecycle-emails.timer (installing it is an ops step).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import { runTrialLifecycleEmails } from '@/modules/onboarding/services/trialLifecycle/runTrialLifecycleEmails';
import { clampLimit } from '@/modules/onboarding/services/trialLifecycle/runOptions';

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-trial-lifecycle');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-trial-lifecycle');
    return apiResponse.unauthorized(res);
  }

  const query = req.query ?? {};
  const dryRun = ['1', 'true'].includes(String(first(query.dry_run) ?? '').toLowerCase());
  const limit = clampLimit(first(query.limit));
  log.info('Cron triggered: trial lifecycle emails', { dryRun, limit }, 'cron-trial-lifecycle');
  const result = await runTrialLifecycleEmails({ dryRun, limit });
  if (result.failed > 0) {
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, `Trial lifecycle emails: ${result.failed} of ${result.processed} companies failed`, result);
  }
  return apiResponse.success(res, result);
}

// NOTE: no withAuth: system-level cron endpoint
export default withErrorHandler(handler as never);
