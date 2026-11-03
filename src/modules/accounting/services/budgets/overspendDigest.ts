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
 *   - `sendOverspendDigest` (after that transaction committed): `sendEmail` per recipient.
 * Evaluate now (the button) sends no email: the digest belongs to the daily run.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '../core/emailService';
import {
  renderBudgetDigestHtml, renderBudgetDigestSubject, type BudgetDigestAlert,
} from '@/lib/email-templates-budget-digest';
import { alertEmailAllowedOnServer, readControlSettings } from './budgetControlSettings';
import { monthName, pctText, rand } from './overspendAlertsCore';
import type { FiredAlert } from './overspendAlerts';

export type DigestSkip = 'nothing_fired' | 'server_off' | 'company_off' | 'no_recipients';

export interface DigestEmail {
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
      return { to: String(u.email), subject: renderBudgetDigestSubject(payload), html: renderBudgetDigestHtml(payload) };
    }),
  };
}

export async function sendOverspendDigest(companyId: string, plan: DigestPlan): Promise<DigestOutcome> {
  if (plan.skip !== null) return { skipped: plan.skip, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const e of plan.emails) {
    try {
      const r = await sendEmail({ to: e.to, subject: e.subject, html: e.html, _log: { companyId, emailType: 'other', sentBy: null } });
      if (r.success) sent += 1;
      else {
        failed += 1;
        log.warn('budget digest: send failed', { companyId, error: r.error ?? 'unknown' }, 'accounting');
      }
    } catch (err) {
      failed += 1;
      log.error('budget digest: send threw', { companyId, error: err instanceof Error ? err.message : String(err) }, 'accounting');
    }
  }
  return { skipped: null, sent, failed };
}
