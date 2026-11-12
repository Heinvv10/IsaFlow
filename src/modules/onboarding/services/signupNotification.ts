/**
 * The ops mail for a verified self-serve sign-up (verify-email). Fire and
 * forget: only reachable for a verified address, so it cannot be used to
 * flood the ops inbox, and a send failure is logged, never surfaced.
 *
 * For an Accountant sign-up it carries one more line: whether the bureau was
 * set up automatically (signupBureauService) or needs the admin conversion.
 */
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { log } from '@/lib/logger';
import type { SignupBureauResult } from '@/modules/bureau/services/signupBureauService';

/** Where new-tenant notifications land. Only fires for VERIFIED signups. */
const NOTIFY_TO = 'ai@velocityfibre.co.za';

/** Escape untrusted values before they go into the notification email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SignupNotice {
  email: string;
  companyName: string;
  /** As stored in the token row; a legacy payload may lack it, hence String() below. */
  signupType: string;
  companyId: string;
  ownerUserId: string;
  /** null when no bureau step ran (a direct sign-up). */
  bureau: SignupBureauResult | null;
}

function bureauLine(n: SignupNotice): string {
  if (!n.bureau) return '';
  if (n.bureau.status === 'failed') {
    return `<li><strong>Bureau:</strong> automatic setup FAILED, convert on /admin/users/${escapeHtml(n.ownerUserId)}</li>`;
  }
  if (n.bureau.status === 'existing') {
    // Reachable only when two live tokens provisioned a second company for one user.
    return `<li><strong>Bureau:</strong> already existed (${escapeHtml(n.bureau.bureauId)}); a second company was provisioned for this user, check /admin/users/${escapeHtml(n.ownerUserId)}</li>`;
  }
  return `<li><strong>Bureau:</strong> created automatically (${escapeHtml(n.bureau.bureauId)})</li>`;
}

export function notifySignup(n: SignupNotice): void {
  sendEmail({
    to: NOTIFY_TO,
    subject: `IsaFlow signup: ${n.email}`,
    html:
      `<p>New verified self-serve signup.</p>` +
      `<ul>` +
      `<li><strong>Email:</strong> ${escapeHtml(n.email)}</li>` +
      `<li><strong>Company:</strong> ${escapeHtml(n.companyName)}</li>` +
      `<li><strong>Type:</strong> ${escapeHtml(String(n.signupType))}</li>` +
      `<li><strong>Company ID:</strong> ${n.companyId}</li>` +
      bureauLine(n) +
      `</ul>`,
    // companyId null: internal ops mail. Logging it against the new tenant would
    // surface it inside their own Customer Communication report, which filters
    // email_log by company_id.
    _log: { companyId: null, emailType: 'other', sentBy: null },
  }).catch((err: unknown) => {
    log.error('signup notification email failed', {
      error: err instanceof Error ? err.message : String(err),
      companyId: n.companyId,
    }, 'auth');
  });
}
