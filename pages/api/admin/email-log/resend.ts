/**
 * Admin Email Log — Resend
 * POST /api/admin/email-log/resend
 * Body: { logId: string }
 *
 * Fetches the original email_log entry and re-sends the email using
 * the stored recipient, subject, and email_type metadata.
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import type { EmailType } from '@/modules/accounting/services/core/emailService';

type Row = Record<string, unknown>;

// ─── XSS guard ────────────────────────────────────────────────────────────────

/** Escape DB-sourced strings before interpolating into HTML to prevent XSS. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Simple generic HTML for resent emails ────────────────────────────────────

function buildResendHtml(subject: string, recipientEmail: string, emailType: string): string {
  // F-05: All three values come from the DB — escape them before HTML interpolation.
  const safeSubject   = escapeHtml(subject);
  const safeEmail     = escapeHtml(recipientEmail);
  const safeEmailType = escapeHtml(emailType);
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#333;max-width:600px;margin:40px auto;padding:0 20px">
  <h2 style="color:#0d9488">${safeSubject}</h2>
  <p>This is a resent copy of the original <strong>${safeEmailType}</strong> email originally sent to <em>${safeEmail}</em>.</p>
  <p>If you have questions, please contact us at <a href="mailto:accounts@isaflow.co.za">accounts@isaflow.co.za</a>.</p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
  <p style="font-size:12px;color:#9ca3af">Sent by ISAFlow &mdash; <a href="https://app.isaflow.co.za">app.isaflow.co.za</a></p>
</body>
</html>`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { logId } = req.body as { logId?: string };
  if (!logId || typeof logId !== 'string') {
    return apiResponse.badRequest(res, 'logId is required');
  }

  try {
    // Fetch the log entry
    const rows = (await sql`
      SELECT id, company_id, recipient_email, subject, email_type, status
      FROM email_log
      WHERE id = ${logId}::UUID
      LIMIT 1
    `) as Row[];

    if (rows.length === 0) {
      return apiResponse.notFound(res, 'Email log entry not found');
    }

    const entry = rows[0]!;
    const recipientEmail = String(entry.recipient_email ?? '');
    const subject        = String(entry.subject ?? '');
    const emailType      = String(entry.email_type ?? 'other') as EmailType;
    const companyId      = entry.company_id != null ? String(entry.company_id) : null;

    if (!recipientEmail) {
      return apiResponse.badRequest(res, 'No recipient email stored for this log entry');
    }

    const html = buildResendHtml(subject, recipientEmail, emailType);

    const result = await sendEmail({
      to: recipientEmail,
      subject: `[Resent] ${subject}`,
      html,
      _log: {
        companyId,
        emailType,
        sentBy: req.user.id,
      },
    });

    if (!result.success) {
      log.warn('Resend failed', { logId, error: result.error }, 'admin-email-log-resend');
      return apiResponse.badRequest(res, result.error ?? 'Failed to resend email');
    }

    log.info('Email resent by admin', { logId, recipientEmail, adminId: req.user.id }, 'admin-email-log-resend');
    return apiResponse.success(res, { resent: true, messageId: result.messageId });

  } catch (err) {
    log.error('Resend error', { logId, error: err instanceof Error ? err.message : err }, 'admin-email-log-resend');
    return apiResponse.internalError(res, err);
  }
}

export default withAdmin(handler);
