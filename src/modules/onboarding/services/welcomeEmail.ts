/**
 * The welcome email for a new trial owner, sent by verify-email once their
 * tenant is provisioned and their address confirmed. Fire and forget: a
 * failure is logged and never reaches the verification answer.
 *
 * Once per company: verify-email reaches this only in the branch where its own
 * transaction created the company, and a 'sent' welcome row in email_log
 * blocks any later send. That guard is check-then-send, not an atomic claim.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { welcomeEmailHtml, welcomeEmailSubject, type WelcomeVariant } from '@/lib/email-templates-auth';
import { TRIAL_DAYS } from './trialPeriod';

export interface WelcomeNotice {
  companyId: string;
  email: string;
  firstName: string | null;
  companyName: string;
  /** As stored in the token row: 'accountant' or 'direct' (a legacy payload may lack it). */
  signupType: string;
}

export type WelcomeOutcome = 'sent' | 'skipped' | 'failed';

/** Awaitable core, for tests. Never throws. */
export async function sendWelcomeEmailOnce(n: WelcomeNotice): Promise<WelcomeOutcome> {
  try {
    // Bare sql runs as the service role, whose email_log policy is USING (true) (migration 915).
    const rows = (await sql`
      SELECT COALESCE(c.is_demo, false) AS is_demo,
             EXISTS (SELECT 1 FROM email_log el
                      WHERE el.company_id = c.id
                        AND el.email_type = 'welcome'
                        AND el.status = 'sent') AS already_sent
        FROM companies c
       WHERE c.id = ${n.companyId}::uuid
    `) as Array<{ is_demo: boolean; already_sent: boolean }>;
    const row = rows[0];
    if (!row || row.is_demo || row.already_sent) {
      log.info('welcome email skipped', {
        companyId: n.companyId, reason: !row ? 'no_company' : row.is_demo ? 'demo' : 'already_sent',
      }, 'auth');
      return 'skipped';
    }

    const variant: WelcomeVariant = n.signupType === 'accountant' ? 'accountant' : 'sme';
    const result = await sendEmail({
      to: n.email,
      subject: welcomeEmailSubject(variant),
      html: welcomeEmailHtml({
        name: n.firstName?.trim() || 'there',
        companyName: n.companyName,
        variant,
        trialDays: TRIAL_DAYS,
      }),
      // Logged against the new tenant: that row is the once-per-company guard.
      _log: { companyId: n.companyId, emailType: 'welcome', sentBy: null },
    });
    if (!result.success) {
      log.error('welcome email failed', { companyId: n.companyId, error: result.error }, 'auth');
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    log.error('welcome email failed', {
      companyId: n.companyId, error: err instanceof Error ? err.message : String(err),
    }, 'auth');
    return 'failed';
  }
}

/** Fire and forget, for verify-email. */
export function sendWelcomeEmail(n: WelcomeNotice): void {
  void sendWelcomeEmailOnce(n);
}
