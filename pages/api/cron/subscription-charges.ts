/**
 * Cron — generates and runs subscription debits.
 *
 * Cadence: daily (scripts/isaflow-subscription-charges.timer). First pass generates queued rows for any subscriptions
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
 * never billed and its status is left alone. Each live run lists those as
 * unbilled and raises one alert: a log.error with alertKey
 * 'billing.unbilled_no_mandate', which reaches Bugsink. The admin health alert
 * (checkAndAlert) is not used: it alerts on a whole system-health snapshot and
 * its status is reset by the 5-minute health pass, so it has no way to carry a
 * billing finding.
 *
 * A lapsed subscription (period end more than one cycle ago) is charged once
 * for a period from today, never back-billed; the run returns it in
 * generated.resetLapsed, the dry run in resetLapsed (subscriptionChargePlan).
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

/** Stable key for the once-per-run unbilled alert; search Bugsink and the journal for it. */
const UNBILLED_ALERT_KEY = 'billing.unbilled_no_mandate';

function isDryRun(req: NextApiRequest): boolean {
  const q = req.query?.dry_run;
  const body = req.body as { dryRun?: unknown } | undefined;
  return q === '1' || q === 'true' || body?.dryRun === true;
}

async function dryRun(res: NextApiResponse, started: number) {
  const plan = await planDueCharges();
  const chargeable = await selectChargeableCharges();
  const view = ({ companyId, subscriptionId, periodStart, periodEnd, amountCents, currentPeriodEnd, daysOverdue, cyclesSkipped }:
    Awaited<ReturnType<typeof planDueCharges>>[number]) =>
    ({ companyId, subscriptionId, periodStart, periodEnd, amountCents, currentPeriodEnd, daysOverdue, cyclesSkipped });
  const create = plan.filter((p) => p.outcome === 'create');
  const unbilled = plan.filter((p) => p.outcome === 'unbilled_no_mandate');
  const reset = create.filter((p) => p.cyclesSkipped > 0);
  const result = {
    dryRun: true,
    durationMs: Date.now() - started,
    wouldCreateCount: create.length,
    wouldCreate: create.slice(0, DRY_RUN_LIST_CAP).map(view),
    unbilledCount: unbilled.length,
    unbilled: unbilled.slice(0, DRY_RUN_LIST_CAP).map(view),
    resetLapsedCount: reset.length,
    resetLapsed: reset.slice(0, DRY_RUN_LIST_CAP).map((p) => ({
      companyId: p.companyId, subscriptionId: p.subscriptionId, cyclesSkipped: p.cyclesSkipped,
      previousPeriodEnd: p.currentPeriodEnd, periodStart: p.periodStart, periodEnd: p.periodEnd,
    })),
    skipped: {
      existing: plan.filter((p) => p.outcome === 'skip_existing').length,
      zeroAmount: plan.filter((p) => p.outcome === 'skip_zero_amount').length,
    },
    wouldAttempt: chargeable.length,
  };
  log.info('Cron dry run: subscription-charges', {
    durationMs: result.durationMs, wouldCreate: result.wouldCreateCount,
    unbilled: result.unbilledCount, resetLapsed: result.resetLapsedCount, wouldAttempt: result.wouldAttempt,
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
    log.error(
      'Paid subscriptions not billed: no active Paystack mandate',
      {
        alertKey: UNBILLED_ALERT_KEY,
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
      unbilledNoMandate: generated.unbilledNoMandate, resetLapsed: generated.resetLapsedCount,
      cancelled: generated.cancelled,
      voided: generated.voided, ...ran, staleVerified: verified,
    },
    'cron-subscription-charges',
  );
  return apiResponse.success(res, { durationMs, verified, generated, ran });
}

export default withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]);
