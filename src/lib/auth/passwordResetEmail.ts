/**
 * Email a user a self-owned, single-use password-reset link.
 *
 * Shared by /api/auth/forgot-password and the admin "Reset password" action.
 * The token comes from passwordResetService (only its hash is stored) and rides
 * in the URL fragment, never the query string: fragments are not sent to the
 * server, not logged, not put in the Referer header, and not seen by the
 * analytics tracker that runs on every page. Never GoTrue's generate_link —
 * that sends nothing and returns a recovery session to whoever called it.
 */
import { createPasswordResetToken } from './passwordResetService';
import { sendEmail } from '@/modules/accounting/services/core/emailService';
import { emailLayout, ctaButton } from '@/lib/email-templates-shared';

export class PasswordResetEmailNotSentError extends Error {
  constructor(reason: string) {
    super(`Password reset email could not be sent: ${reason}`);
    this.name = 'PasswordResetEmailNotSentError';
  }
}

/** Throws PasswordResetEmailNotSentError when the mail transport refuses it. */
export async function sendPasswordResetEmail(userId: string, email: string): Promise<void> {
  const { token } = await createPasswordResetToken(userId);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const resetUrl = `${appUrl}/reset-password#token=${token}`;
  const html = emailLayout(`
      <h2>Reset your ISAFlow password</h2>
      <p>We received a request to reset the password for this account.</p>
      <p>Click the button below to choose a new password. This link expires in 1 hour and can be used once.</p>
      ${ctaButton('Reset Password', resetUrl)}
      <p style="font-size:12px;color:#94a3b8;">If you did not request this, you can safely ignore this email — your password will not change.</p>
    `);
  const result = await sendEmail({
    to: email,
    subject: 'Reset your ISAFlow password',
    html,
    _log: { companyId: null, emailType: 'other', sentBy: null },
  });
  if (!result.success) throw new PasswordResetEmailNotSentError(result.error ?? 'unknown mail failure');
}
