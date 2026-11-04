/**
 * The overspend email digest (budgets P5 spec §3d, decision 9): one email per owner/admin listing
 * the alerts a daily run newly fired. BUILT AND OFF: it sends only when BOTH the company's
 * `budget_control_settings.alert_email_enabled` (default false, also when the company has no row)
 * AND the server's env `BUDGET_ALERT_EMAIL_ENABLED=1` are set. Neither is set by this phase;
 * enabling it is Hein's act (a human gate).
 *
 * Two steps, so no email leaves for a run that rolled back:
 *   - `planOverspendDigest` (DB reads, inside the company's evaluation transaction): the gates,
 *     the recipients (active owners and admins with an email) and the rendered emails;
 *   - `sendOverspendDigest` (after that transaction committed): `sendEmail` per recipient, outside
 *     any transaction, each email's `email_log` row written after it in a short transaction of its own.
 * Evaluate now (the button) sends no email: the digest belongs to the daily run.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logEmailAttempt, sendEmail, type EmailResult } from '../core/emailService';
import {
  renderBudgetDigestHtml, renderBudgetDigestSubject, type BudgetDigestAlert,
} from '@/lib/email-templates-budget-digest';
import { alertEmailAllowedOnServer, readControlSettings } from './budgetControlSettings';
import { monthName, pctText, rand } from './overspendAlertsCore';
import type { FiredAlert } from './overspendAlerts';

export type DigestSkip = 'nothing_fired' | 'server_off' | 'company_off' | 'no_recipients';

export interface DigestEmail {
  id: string;
  to: string;
  subject: string;
  html: string;
}

export type DigestPlan = { skip: DigestSkip } | { skip: null; emails: DigestEmail[] };

export interface DigestOutcome {
  skipped: DigestSkip | null;
  sent: number;
  failed: number;
}

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
const PENDING_DIGEST_KEY = 'budget_alerts.pending_digest';

function parsePending(raw: unknown): DigestEmail[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'string') throw new Error('Invalid pending budget digest');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid pending budget digest'); }
  if (!Array.isArray(parsed) || !parsed.every((e) => {
    const v = e as Partial<DigestEmail>;
    return typeof v.id === 'string' && typeof v.to === 'string' && typeof v.subject === 'string' && typeof v.html === 'string';
  })) throw new Error('Invalid pending budget digest');
  return parsed as DigestEmail[];
}

async function readPending(companyId: string): Promise<DigestEmail[]> {
  const rows = (await sql`
    SELECT value FROM accounting_settings
     WHERE company_id = ${companyId}::UUID AND key = ${PENDING_DIGEST_KEY}
  `) as DbRow[];
  return parsePending(rows[0]?.value);
}

async function writePending(companyId: string, emails: readonly DigestEmail[]): Promise<void> {
  if (emails.length === 0) {
    await sql`DELETE FROM accounting_settings WHERE company_id = ${companyId}::UUID AND key = ${PENDING_DIGEST_KEY}`;
    return;
  }
  await sql`
    INSERT INTO accounting_settings (company_id, key, value)
    VALUES (${companyId}::UUID, ${PENDING_DIGEST_KEY}, ${JSON.stringify(emails)})
    ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

function digestAlert(a: FiredAlert): BudgetDigestAlert {
  return {
    accountCode: a.accountCode, accountName: a.accountName, sliceName: a.sliceName, monthLabel: monthName(a.month),
    threshold: a.threshold, budget: rand(a.budget), spent: rand(a.actual + a.committed), pctLabel: pctText(a.pct),
    href: a.href, refired: a.refired,
  };
}

export async function planOverspendDigest(companyId: string, fired: readonly FiredAlert[]): Promise<DigestPlan> {
  if (fired.length === 0) return { skip: 'nothing_fired' };
  if (!alertEmailAllowedOnServer()) return { skip: 'server_off' };
  if (!(await readControlSettings(companyId)).alertEmailEnabled) return { skip: 'company_off' };
  const users = (await sql`
    SELECT DISTINCT u.email, COALESCE(NULLIF(btrim(u.first_name), ''), u.email) AS name
      FROM company_users cu JOIN users u ON u.id = cu.user_id
     WHERE cu.company_id = ${companyId}::UUID AND cu.role IN ('owner', 'admin')
       AND u.is_active IS TRUE AND u.status IS DISTINCT FROM 'suspended' AND u.suspended_at IS NULL
       AND btrim(COALESCE(u.email, '')) <> ''
     ORDER BY u.email
  `) as DbRow[];
  if (users.length === 0) return { skip: 'no_recipients' };
  const company = (await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  const alerts = fired.map(digestAlert);
  return {
    skip: null,
    emails: users.map((u) => {
      const payload = { companyName: String(company[0]?.name ?? ''), recipientName: String(u.name), alerts, appBaseUrl: APP_BASE_URL };
      return { id: crypto.randomUUID(), to: String(u.email), subject: renderBudgetDigestSubject(payload), html: renderBudgetDigestHtml(payload) };
    }),
  };
}

/** Persists a fresh plan before SMTP and includes any recipients still pending from an earlier run. */
export async function enqueueOverspendDigest(companyId: string, plan: DigestPlan): Promise<DigestPlan> {
  if (plan.skip !== null) return plan;
  const emails = [...await readPending(companyId), ...plan.emails];
  await writePending(companyId, emails);
  return { skip: null, emails };
}

/** Loads a persisted retry only while both email switches remain enabled. */
export async function pendingOverspendDigest(companyId: string): Promise<DigestPlan> {
  const emails = await readPending(companyId);
  if (emails.length === 0) return { skip: 'nothing_fired' };
  if (!alertEmailAllowedOnServer()) return { skip: 'server_off' };
  if (!(await readControlSettings(companyId)).alertEmailEnabled) return { skip: 'company_off' };
  return { skip: null, emails };
}

export async function acknowledgeOverspendDigest(companyId: string, emailId: string): Promise<void> {
  await writePending(companyId, (await readPending(companyId)).filter((e) => e.id !== emailId));
}

/**
 * Sends each planned email OUTSIDE any transaction (a slow mail server holds no pooled connection),
 * then writes that email's `email_log` row through `inLogContext` (the cron: a short company-context
 * transaction on its own pool and role). `sent`/`failed` count actual outcomes, one per email; a send
 * that throws is one failure and the others still go.
 */
export async function sendOverspendDigest(
  companyId: string, plan: DigestPlan, inLogContext: (write: () => Promise<void>) => Promise<void> = (write) => write(),
  acknowledge: (emailId: string) => Promise<void> = async () => undefined,
): Promise<DigestOutcome> {
  if (plan.skip !== null) return { skipped: plan.skip, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const e of plan.emails) {
    let r: EmailResult;
    try {
      r = await sendEmail({ to: e.to, subject: e.subject, html: e.html });
    } catch (err) {
      r = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (r.success) sent += 1;
    else {
      failed += 1;
      log.warn('budget digest: send failed', { companyId, error: r.error ?? 'unknown' }, 'accounting');
    }
    try {
      await inLogContext(async () => {
        await logEmailAttempt({
          companyId, recipientEmail: e.to, subject: e.subject, emailType: 'other',
          status: r.success ? 'sent' : 'failed', errorMessage: r.success ? undefined : r.error ?? 'unknown', sentBy: null,
        });
        if (r.success) await acknowledge(e.id);
      });
    } catch (err) {
      if (r.success) failed += 1; // accepted by SMTP but not durably acknowledged: keep the run retryable
      log.error('budget digest: email_log write failed', { companyId, error: err instanceof Error ? err.message : String(err) }, 'accounting');
    }
  }
  return { skipped: null, sent, failed };
}
