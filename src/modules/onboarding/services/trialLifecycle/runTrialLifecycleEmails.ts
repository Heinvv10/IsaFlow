/**
 * The daily trial lifecycle email run behind `POST /api/cron/trial-lifecycle-emails`
 * (timer scripts/isaflow-trial-lifecycle-emails.timer, installed by ops, never by code).
 *
 * - Candidates (candidates.ts) → the highest due stage per company, unless that or a higher one is done
 *   (stages.ts) → at most `limit` companies, earliest trial end first.
 * - Real sends need env TRIAL_LIFECYCLE_EMAILS_ENABLED=1. Without it, and with `dryRun`, the run only
 *   reports what it would do: no marker written, no email sent. The report names companies by id and
 *   counts recipients; it never lists addresses.
 * - Per company: in its own service transaction, read the owners (none → `no_recipient`, nothing
 *   written) and, for day 3, the open setup steps (none → the stage is recorded skipped, nothing sent);
 *   claim the stage (conflict → `already_claimed`); COMMIT. Then each owner's email is sent with no
 *   transaction open, and its email_log row written in a short company-context transaction.
 *   Outcome: any success → 'sent'; no success but one may have left → 'unknown' (kept: at most once
 *   beats a duplicate); every send provably not sent → 'released', so tomorrow retries.
 * - One company's failure is logged and counted; the run goes on.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { sendEmail, logEmailAttempt, type EmailResult } from '@/modules/accounting/services/core/emailService';
import { TRIAL_CONTACT_EMAIL } from '@/lib/email-templates-trial/shared';
import { loadOwners, loadTrialCandidates, type TrialCandidate } from './candidates';
import { claimStage, finaliseStage, type FinalOutcome } from './markers';
import { openSetupSteps, renderStage } from './compose';
import { dueStage, stageToSend, type TrialStage } from './stages';
import { clampLimit, sendsEnabled } from './runOptions';

export const TRIAL_LIFECYCLE_ACTOR = 'system:trial-lifecycle';
const STATEMENT_TIMEOUT_MS = 60_000;
const SEND_DEADLINE_MS = 60_000;
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';

export type CompanyAction =
  | 'sent' | 'unknown' | 'released' | 'skipped_setup_complete' | 'no_recipient' | 'already_claimed'
  | 'would_send' | 'would_skip_setup_complete' | 'failed';

export interface CompanyResult {
  companyId: string;
  stage: TrialStage;
  action: CompanyAction;
  recipients: number;
  /** A fixed phrase (the log holds the detail). */
  error?: string;
}

export interface TrialLifecycleResult {
  dryRun: boolean;
  /** False when TRIAL_LIFECYCLE_EMAILS_ENABLED is not 1: the run was a dry run whatever was asked. */
  enabled: boolean;
  limit: number;
  due: number;
  processed: number;
  failed: number;
  emailsSent: number;
  perCompany: CompanyResult[];
}

async function inServiceTx<T>(companyId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withAlsTransaction({ userId: TRIAL_LIFECYCLE_ACTOR, companyId }, async () => {
    if (companyId) await sql`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    await sql`
      SELECT set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}::TEXT, true) FROM pg_catalog.pg_settings
       WHERE name = 'statement_timeout' AND (setting::BIGINT = 0 OR setting::BIGINT > ${STATEMENT_TIMEOUT_MS}::BIGINT)
    `;
    return fn();
  });
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function runCompany(c: TrialCandidate, stage: TrialStage, dryRun: boolean): Promise<CompanyResult> {
  const base = { companyId: c.companyId, stage };
  const prep = await inServiceTx(c.companyId, async () => {
    const owners = await loadOwners(c.companyId);
    if (owners.length === 0) return { action: 'no_recipient' as const, owners };
    const steps = stage === 'setup_nudge' ? await openSetupSteps(c.companyId) : [];
    if (stage === 'setup_nudge' && steps.length === 0) {
      if (dryRun) return { action: 'would_skip_setup_complete' as const, owners };
      const claimed = await claimStage(c.companyId, stage, 'skipped_setup_complete');
      return { action: claimed ? 'skipped_setup_complete' as const : 'already_claimed' as const, owners };
    }
    if (dryRun) return { action: 'would_send' as const, owners, steps };
    const claimed = await claimStage(c.companyId, stage);
    return { action: claimed ? 'send' as const : 'already_claimed' as const, owners, steps };
  });
  if (prep.action !== 'send') {
    return { ...base, action: prep.action, recipients: prep.action === 'no_recipient' ? 0 : prep.owners.length };
  }

  let sent = 0;
  let mayHaveLeft = false;
  for (const owner of prep.owners) {
    const email = renderStage(stage, {
      companyName: c.companyName, recipientName: owner.name, trialEndsAt: c.trialEndsAt, appBaseUrl: APP_BASE_URL,
    }, prep.steps ?? []);
    let r: EmailResult;
    try {
      r = await sendEmail({ to: owner.email, replyTo: TRIAL_CONTACT_EMAIL, subject: email.subject, html: email.html, deadlineMs: SEND_DEADLINE_MS });
    } catch (e) {
      r = { success: false, error: err(e) };
    }
    if (r.success) sent += 1;
    else {
      if (!r.provablyNotSent) mayHaveLeft = true;
      log.warn('trial lifecycle: send failed', { companyId: c.companyId, stage, provablyNotSent: r.provablyNotSent === true, error: r.error ?? 'unknown' }, 'cron-trial-lifecycle');
    }
    try {
      await inServiceTx(c.companyId, () => logEmailAttempt({
        companyId: c.companyId, recipientEmail: owner.email, subject: email.subject, emailType: 'trial_lifecycle',
        status: r.success ? 'sent' : 'failed', errorMessage: r.success ? undefined : r.error ?? 'unknown', sentBy: null,
      }));
    } catch (e) {
      log.error('trial lifecycle: email_log write failed', { companyId: c.companyId, error: err(e) }, 'cron-trial-lifecycle');
    }
  }
  const outcome: FinalOutcome = sent > 0 ? 'sent' : mayHaveLeft ? 'unknown' : 'released';
  // A failure here leaves the marker 'pending', which still blocks a resend; the throw marks the company failed.
  await inServiceTx(c.companyId, () => finaliseStage(c.companyId, stage, outcome, sent));
  return { ...base, action: outcome, recipients: sent };
}

export async function runTrialLifecycleEmails(opts: { now?: Date; dryRun?: boolean; limit?: number } = {}): Promise<TrialLifecycleResult> {
  const now = opts.now ?? new Date();
  const enabled = sendsEnabled();
  const dryRun = opts.dryRun === true || !enabled;
  const limit = clampLimit(opts.limit);
  const candidates = await inServiceTx(undefined, () => loadTrialCandidates(now));
  const due = candidates
    .map((c) => ({ c, stage: stageToSend(dueStage({ createdAt: c.createdAt, trialEndsAt: c.trialEndsAt, now }), c.doneStages) }))
    .filter((x): x is { c: TrialCandidate; stage: TrialStage } => x.stage !== null);
  const batch = due.slice(0, limit);
  const perCompany: CompanyResult[] = [];
  for (const { c, stage } of batch) {
    try {
      perCompany.push(await runCompany(c, stage, dryRun));
    } catch (e) {
      log.error('trial lifecycle: company failed', { companyId: c.companyId, stage, error: err(e), code: (e as { code?: unknown })?.code }, 'cron-trial-lifecycle');
      perCompany.push({ companyId: c.companyId, stage, action: 'failed', recipients: 0, error: 'company run failed; see logs' });
    }
  }
  const failed = perCompany.filter((r) => r.action === 'failed').length;
  const emailsSent = perCompany.reduce((n, r) => n + (r.action === 'sent' ? r.recipients : 0), 0);
  log.info('trial lifecycle: run done', { dryRun, enabled, due: due.length, processed: batch.length, failed, emailsSent }, 'cron-trial-lifecycle');
  return { dryRun, enabled, limit, due: due.length, processed: batch.length, failed, emailsSent, perCompany };
}
