/**
 * Cron — generates and runs subscription debits.
 *
 * Cadence: hourly. First pass generates queued rows for any subscriptions
 * whose period has ended; second pass submits queued/retry-eligible debits
 * to Stitch via the active LinkPay mandate.
 *
 * Auth: X-Cron-Secret header must match CRON_SECRET env var.
 *
 * Dry run: POST ?dry_run=1 (or body { "dryRun": true }), same auth. Runs only
 * the read-only planners (planDueCharges, selectChargeableCharges) and returns
 * what a live run would do: no stale-charge resolution, no insert, void or
 * close-out, no Paystack call. wouldAttempt counts charges already queued or
 * retry-eligible; a live run would also attempt the wouldCreate ones.
 *
 * A paid subscription past its period end with no active Paystack mandate is
 * never billed. Each run lists those as unbilled and logs one warn with their
 * count (scripts/README-subscription-charges-cron.md).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { timingSafeEqualStr } from '@/lib/timingSafe';
import {
  generateDueCharges,
  runQueuedCharges,
} from '@/modules/billing/services/subscriptionBillingService';
import { resolveStaleSubmittedCharges } from '@/modules/billing/services/subscriptionChargeVerify';
import { planDueCharges, selectChargeableCharges } from '@/modules/billing/services/subscriptionChargePlan';

/** Most rows listed per dry-run list; the counts are never capped. */
const DRY_RUN_LIST_CAP = 200;

function isDryRun(req: NextApiRequest): boolean {
  const q = req.query?.dry_run;
  const body = req.body as { dryRun?: unknown } | undefined;
  return q === '1' || q === 'true' || body?.dryRun === true;
}

async function dryRun(res: NextApiResponse, started: number) {
  const plan = await planDueCharges();
  const chargeable = await selectChargeableCharges();
  const view = ({ companyId, subscriptionId, periodStart, periodEnd, amountCents, currentPeriodEnd, daysOverdue }:
    Awaited<ReturnType<typeof planDueCharges>>[number]) =>
    ({ companyId, subscriptionId, periodStart, periodEnd, amountCents, currentPeriodEnd, daysOverdue });
  const create = plan.filter((p) => p.outcome === 'create');
  const unbilled = plan.filter((p) => p.outcome === 'unbilled_no_mandate');
  const result = {
    dryRun: true,
    durationMs: Date.now() - started,
    wouldCreateCount: create.length,
    wouldCreate: create.slice(0, DRY_RUN_LIST_CAP).map(view),
    unbilledCount: unbilled.length,
    unbilled: unbilled.slice(0, DRY_RUN_LIST_CAP).map(view),
    skipped: {
      existing: plan.filter((p) => p.outcome === 'skip_existing').length,
      zeroAmount: plan.filter((p) => p.outcome === 'skip_zero_amount').length,
    },
    wouldAttempt: chargeable.length,
  };
  log.info('Cron dry run: subscription-charges', {
    durationMs: result.durationMs, wouldCreate: result.wouldCreateCount,
    unbilled: result.unbilledCount, wouldAttempt: result.wouldAttempt,
  }, 'cron-subscription-charges');
  return apiResponse.success(res, result);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  if (!process.env.CRON_SECRET) {
    log.error('CRON_SECRET env var not set', {}, 'cron-subscription-charges');
    return apiResponse.internalError(res, new Error('Cron secret not configured'));
  }
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || !timingSafeEqualStr(String(cronSecret), process.env.CRON_SECRET ?? '')) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-subscription-charges');
    return apiResponse.unauthorized(res);
  }

  const started = Date.now();
  if (isDryRun(req)) return dryRun(res, started);
  log.info('Cron triggered: subscription-charges', {}, 'cron-subscription-charges');

  // Resolve last run's unanswered submissions first, so a charge whose webhook
  // never arrived does not defer a close-out or block the next period forever.
  const verified = await resolveStaleSubmittedCharges();
  const generated = await generateDueCharges();
  const ran = await runQueuedCharges();
  const durationMs = Date.now() - started;

  if (generated.unbilledNoMandate > 0) {
    log.warn(
      'Paid subscriptions not billed: no active Paystack mandate',
      {
        reason: 'unbilled_no_mandate',
        count: generated.unbilledNoMandate,
        subscriptionIds: generated.unbilled.map((u) => u.subscriptionId),
      },
      'cron-subscription-charges',
    );
  }

  log.info(
    'Cron complete: subscription-charges',
    {
      durationMs, created: generated.created, skippedGenerate: generated.skipped,
      unbilledNoMandate: generated.unbilledNoMandate, cancelled: generated.cancelled,
      voided: generated.voided, ...ran, staleVerified: verified,
    },
    'cron-subscription-charges',
  );
  return apiResponse.success(res, { durationMs, verified, generated, ran });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
