/**
 * Which owners/admins are still owed a budget digest: the retry state of the email digest, derived from
 * `email_log` and `budget_alerts` (no table of its own).
 *
 * Crossings commit BEFORE the email goes, so a send that failed would otherwise lose that recipient's
 * digest for good (the next run only mails what it newly fires). Every attempt writes one `email_log`
 * row per recipient (`overspendDigest.ts`), and a company's digest rows are told by their subject prefix.
 * A recipient is OWED a digest when they have a `failed` row, newer than their last `sent` one, within
 * the last RETRY_DAYS. What they are owed: the company's still-open alerts fired after that last `sent`
 * row (everything up to it went out in that digest) and no earlier than an hour before their oldest
 * unanswered failure (the alert fires in the evaluation transaction, the email seconds after), up to
 * their newest failure (an alert from after it, e.g. by Evaluate now, never had a digest due).
 * A retry that fails again adds a newer `failed` row, so the debt carries on until it is delivered or
 * ages out; one that succeeds writes the `sent` row that clears it. Only the failed recipients are
 * retried: a recipient whose send went through has a `sent` row after every alert, so nothing is owed.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { DIGEST_SUBJECT_PREFIX } from '@/lib/email-templates-budget-digest';
import { named, type FiredAlert } from './overspendAlerts';
import { mapRow, RETURNED } from './overspendAlertsWrite';

/** A failed digest is retried by each daily run for this many days, then given up (the failure stays in email_log). */
export const RETRY_DAYS = 3;

/** Lower-cased recipient email → the alerts that recipient is still owed. */
export async function readPendingDigestAlerts(companyId: string): Promise<Map<string, FiredAlert[]>> {
  const rows = (await sql`
    WITH digest AS (
      SELECT lower(recipient_email) AS email, status, sent_at FROM email_log
       WHERE company_id = ${companyId}::UUID AND email_type = 'other' AND subject LIKE ${`${DIGEST_SUBJECT_PREFIX}%`}
    ), delivered AS (
      SELECT email, max(sent_at) AS at FROM digest WHERE status = 'sent' GROUP BY email
    ), owed AS (
      SELECT d.email, min(d.sent_at) AS first_failed, max(d.sent_at) AS last_failed, max(o.at) AS delivered_at
        FROM digest d LEFT JOIN delivered o ON o.email = d.email
       WHERE d.status = 'failed' AND d.sent_at > now() - make_interval(days => ${RETRY_DAYS})
         AND (o.at IS NULL OR d.sent_at > o.at)
       GROUP BY d.email
    )
    SELECT owed.email AS recipient, ${RETURNED}
      FROM owed JOIN budget_alerts a ON a.company_id = ${companyId}::UUID
       AND a.resolved_at IS NULL
       AND a.fired_at > owed.first_failed - interval '1 hour'
       AND a.fired_at > COALESCE(owed.delivered_at, '-infinity'::TIMESTAMPTZ)
       AND a.fired_at <= owed.last_failed
  `) as DbRow[];
  const byId = new Map(await named(companyId, rows.map(mapRow), new Set()).then((l) => l.map((a) => [a.id, a] as const)));
  const out = new Map<string, FiredAlert[]>();
  for (const r of rows) {
    const alert = byId.get(String(r.id));
    if (alert) out.set(String(r.recipient), [...(out.get(String(r.recipient)) ?? []), alert]);
  }
  return out;
}
