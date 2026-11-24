/**
 * IsaFlow Email Templates — Auth (welcome + password reset)
 * Table-based layout with inline styles for broad email client compatibility.
 * Core templates (invite + invoice): src/lib/email-templates.ts
 */

import { BRAND, emailLayout, ctaButton } from '@/lib/email-templates';
import { LEGAL_ENTITY } from '@/config/legalEntity';

// ─── Welcome Email ────────────────────────────────────────────────────────────

export type WelcomeVariant = 'sme' | 'accountant';

export interface WelcomeEmailData {
  name: string;
  companyName: string;
  variant: WelcomeVariant;
  /** Pass TRIAL_DAYS (onboarding/services/trialPeriod); never a literal. */
  trialDays: number;
}

/** The name and company name are user input from the signup form. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function welcomeEmailSubject(variant: WelcomeVariant): string {
  return variant === 'accountant' ? 'Welcome to IsaFlow, your practice is set up' : 'Welcome to IsaFlow';
}

const FEATURES: Record<WelcomeVariant, Array<{ title: string; desc: string }>> = {
  sme: [
    { title: 'Invoicing', desc: 'Create and send invoices.' },
    { title: 'Banking', desc: 'Import bank statements and reconcile your transactions.' },
    { title: 'Reports', desc: 'Run income statements and balance sheets.' },
  ],
  accountant: [
    { title: 'Clients', desc: 'Add your clients and switch between their books.' },
    { title: 'Banking', desc: 'Import statements and reconcile for each client.' },
    { title: 'Reports', desc: 'Run income statements and balance sheets for each client.' },
  ],
};

/**
 * Footer text colour for the welcome layout: 7.2:1 on BRAND.footerBg (#f8fafc), where
 * BRAND.textMuted is 2.6:1. Local on purpose; BRAND is every email's.
 */
export const WELCOME_FOOTER_TEXT = '#475569';

/**
 * The shared header (logo on dark, teal rule) with the welcome email's own footer. The shared
 * emailLayout footer says "Please do not reply directly" (this email asks the reader to write to
 * us), links a preferences page that does not exist, and carries an em dash.
 */
function welcomeLayout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:${BRAND.outerBg};">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="background-color:${BRAND.outerBg}; padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation"
             style="max-width:600px; width:100%; background-color:${BRAND.cardBg}; border-radius:8px; overflow:hidden;">
        <tr><td align="center" style="background-color:${BRAND.darkBg}; padding:28px 32px; border-bottom:3px solid ${BRAND.primaryTeal};">
          <a href="${BRAND.appUrl}" style="text-decoration:none;">
            <img src="${BRAND.logoUrl}" alt="IsaFlow" height="40" style="display:block; max-height:40px; width:auto; border:0;" />
          </a>
        </td></tr>
        ${content}
        <tr><td style="background-color:${BRAND.footerBg}; padding:20px 32px; border-top:1px solid ${BRAND.borderColor};
                       font-family:${BRAND.fontStack}; font-size:12px; color:${WELCOME_FOOTER_TEXT}; line-height:1.5;">
          IsaFlow, South African cloud accounting.<br>
          You are receiving this because you signed up for IsaFlow.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function welcomeEmailHtml(data: WelcomeEmailData): string {
  const strong = (v: string) => `<strong style="color:${BRAND.textBody};">${escapeHtml(v)}</strong>`;
  const trial = `Your ${data.trialDays}-day free trial has started.`;
  const intro = data.variant === 'accountant'
    ? `Hi ${strong(data.name)}, your practice ${strong(data.companyName)} has been created.
          ${trial} Sign in to add your clients and work on their books from one place.`
    : `Hi ${strong(data.name)}, your account for ${strong(data.companyName)} has been created.
          ${trial} Sign in and start managing your accounts.`;
  const mail = escapeHtml(LEGAL_ENTITY.contactEmail);

  const featureCols = FEATURES[data.variant].map((f) => `
    <td style="width:33%; padding:0 8px; text-align:center; vertical-align:top; font-family:${BRAND.fontStack};">
      <div style="width:24px; height:3px; margin:0 auto 10px; background-color:${BRAND.primaryTeal}; font-size:0; line-height:0;">&nbsp;</div>
      <p style="margin:0 0 4px; font-size:13px; font-weight:bold; color:${BRAND.textBody};">${f.title}</p>
      <p style="margin:0; font-size:12px; color:${BRAND.textSecondary}; line-height:1.5;">${f.desc}</p>
    </td>`).join('');

  const content = `
    <tr>
      <td style="padding:36px 32px 28px;">
        <h1 style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:24px;
                   font-weight:bold; color:${BRAND.textBody};">
          Welcome to IsaFlow
        </h1>
        <p style="margin:0 0 24px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          ${intro}
        </p>
        ${ctaButton('Sign in', `${BRAND.appUrl}/login`)}
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border-top:1px solid ${BRAND.borderColor};">
          <tr>
            <td style="padding-top:24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                <tr>${featureCols}</tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top:24px; font-family:${BRAND.fontStack}; font-size:14px; color:${BRAND.textSecondary}; line-height:1.6;">
              Questions? Email us at <a href="mailto:${mail}" style="color:${BRAND.primaryTeal};">${mail}</a>.
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  return welcomeLayout(content);
}

// ─── Password Reset Email ─────────────────────────────────────────────────────

export interface PasswordResetData {
  name: string;
  resetUrl: string;
}

export function passwordResetEmailHtml(data: PasswordResetData): string {
  const content = `
    <tr>
      <td style="padding:36px 32px 28px;">
        <h1 style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:24px;
                   font-weight:bold; color:${BRAND.textBody};">
          Reset Your Password
        </h1>
        <p style="margin:0 0 24px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Hi <strong style="color:${BRAND.textBody};">${data.name}</strong>,<br>
          we received a request to reset the password for your IsaFlow account.
          Click the button below to choose a new password.
        </p>
        ${ctaButton('Reset Password', data.resetUrl)}
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border-top:1px solid ${BRAND.borderColor};">
          <tr>
            <td style="padding-top:20px; font-family:${BRAND.fontStack}; font-size:13px;
                       font-weight:bold; color:${BRAND.textSecondary}; line-height:1.6;">
              This link expires in 1 hour.
            </td>
          </tr>
          <tr>
            <td style="padding-top:8px; font-family:${BRAND.fontStack}; font-size:13px;
                       color:${BRAND.textMuted}; line-height:1.6;">
              If you didn&#8217;t request a password reset, you can safely ignore this email.
              Your password will not change until you click the link above.
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  return emailLayout(content);
}
