/**
 * Email Service
 * Generic email sending via SMTP (nodemailer)
 * Invoice/invite email helpers split to emailNotificationService.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// Resolve the logo once at module load — path works in both dev and production standalone
const LOGO_PATH = (() => {
  const candidates = [
    path.join(process.cwd(), 'public', 'logo-email.png'),
    path.join(__dirname, '..', '..', '..', '..', '..', 'public', 'logo-email.png'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? candidates[0]!;
})();

// ─── Email Log ────────────────────────────────────────────────────────────────

export type EmailType = 'invoice' | 'statement' | 'quote' | 'payment_receipt' | 'invite' | 'practice_digest' | 'practice_monthly' | 'other';

interface EmailLogPayload {
  companyId: string | null;
  recipientEmail: string;
  subject: string;
  emailType: EmailType;
  status: 'sent' | 'failed';
  errorMessage?: string;
  sentBy?: string | null;
}

/** Fire-and-forget: inserts a row into email_log; never throws. */
function logEmailAttempt(payload: EmailLogPayload): void {
  sql`
    INSERT INTO email_log
      (company_id, recipient_email, subject, email_type, status, error_message, sent_by)
    VALUES (
      ${payload.companyId}::UUID,
      ${payload.recipientEmail},
      ${payload.subject},
      ${payload.emailType},
      ${payload.status},
      ${payload.errorMessage ?? null},
      ${payload.sentBy ?? null}
    )
  `.catch((err: unknown) => {
    log.error('Failed to write email_log row', { error: err instanceof Error ? err.message : err }, 'emailService');
  });
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
  /** Optional metadata used to write an email_log row. */
  _log?: { companyId: string | null; emailType: EmailType; sentBy?: string | null };
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── SMTP Configuration ────────────────────────────────────────────────────

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  /**
   * Optional TLS SNI / cert-validation hostname. Use when the SMTP host's
   * certificate is issued for a different name than SMTP_HOST — e.g. a shared
   * mail server reachable as mail.isaflow.co.za but holding a *.jnb1.host-h.net
   * wildcard cert. Setting this to the cert-matching FQDN (www513.jnb1.host-h.net)
   * keeps full TLS verification instead of disabling it.
   */
  tlsServername?: string;
}

function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'accounts@isaflow.co.za';

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port: port ? parseInt(port, 10) : 587,
    user,
    pass,
    from,
    tlsServername: process.env.SMTP_TLS_SERVERNAME || undefined,
  };
}

// ─── Generic Email Sender ───────────────────────────────────────────────────

export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  const config = getSmtpConfig();
  const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;

  if (!config) {
    log.warn('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.', {}, 'emailService');
    if (options._log) {
      logEmailAttempt({
        companyId: options._log.companyId,
        recipientEmail: recipients,
        subject: options.subject,
        emailType: options._log.emailType,
        status: 'failed',
        errorMessage: 'SMTP not configured',
        sentBy: options._log.sentBy ?? null,
      });
    }
    return { success: false, error: 'SMTP not configured' };
  }

  try {
    // Dynamic import to avoid loading nodemailer when not needed
    const nodemailer = await import('nodemailer');

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      // Validate the TLS cert against its real wildcard name when the host the
      // app dials (SMTP_HOST) differs from the cert's CN/SAN. rejectUnauthorized
      // is left at its default (true) — verification stays ON; we only correct
      // the name it verifies against. Without this nodemailer rejects the cert
      // and every send fails.
      ...(config.tlsServername ? { tls: { servername: config.tlsServername } } : {}),
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    // Build inline logo attachment (CID) — embedded so recipients see it without downloading
    const logoAttachment = fs.existsSync(LOGO_PATH)
      ? [{ filename: 'logo.png', path: LOGO_PATH, cid: 'isaflow-logo@isaflow.co.za' }]
      : [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mailOptions: any = {
      from: config.from,
      to: recipients,
      subject: options.subject,
      html: options.html,
      attachments: [
        ...logoAttachment,
        ...(options.attachments?.map((att) => ({
          filename: att.filename,
          content: att.content,
          contentType: att.contentType,
        })) ?? []),
      ],
    };

    const info = await transporter.sendMail(mailOptions);

    log.info('Email sent', {
      messageId: info.messageId,
      to: recipients,
      subject: options.subject,
    }, 'emailService');

    if (options._log) {
      logEmailAttempt({
        companyId: options._log.companyId,
        recipientEmail: recipients,
        subject: options.subject,
        emailType: options._log.emailType,
        status: 'sent',
        sentBy: options._log.sentBy ?? null,
      });
    }

    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown email error';
    log.error('Failed to send email', { error: message, to: options.to }, 'emailService');

    if (options._log) {
      logEmailAttempt({
        companyId: options._log.companyId,
        recipientEmail: recipients,
        subject: options.subject,
        emailType: options._log.emailType,
        status: 'failed',
        errorMessage: message,
        sentBy: options._log.sentBy ?? null,
      });
    }

    return { success: false, error: message };
  }
}

// ─── Re-exports for backward compat ─────────────────────────────────────────
export {
  sendInvoiceEmail,
  sendInviteEmail,
  type InviteEmailOptions,
} from './emailNotificationService';
