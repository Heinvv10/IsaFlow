/**
 * IsaFlow Email Templates — Auth (welcome + password reset)
 * Table-based layout with inline styles for broad email client compatibility.
 * Core templates (invite + invoice): src/lib/email-templates.ts
 */

import { BRAND, emailLayout, ctaButton } from '@/lib/email-templates';

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

const FEATURES: Record<WelcomeVariant, Array<{ icon: string; title: string; desc: string }>> = {
  sme: [
    { icon: '&#128203;', title: 'Invoicing', desc: 'Create and send professional invoices in seconds.' },
    { icon: '&#127968;', title: 'Banking', desc: 'Import bank statements and reconcile your transactions.' },
    { icon: '&#128200;', title: 'Reports', desc: 'Income statements, balance sheets and more.' },
  ],
  accountant: [
    { icon: '&#128101;', title: 'Clients', desc: 'Add your clients and switch between their books.' },
    { icon: '&#127968;', title: 'Banking', desc: 'Import statements and reconcile for each client.' },
    { icon: '&#128200;', title: 'Reports', desc: 'Run income statements and balance sheets for each client.' },
  ],
};

export function welcomeEmailHtml(data: WelcomeEmailData): string {
  const strong = (v: string) => `<strong style="color:${BRAND.textBody};">${escapeHtml(v)}</strong>`;
  const trial = `Your ${data.trialDays}-day free trial has started.`;
  const intro = data.variant === 'accountant'
    ? `Hi ${strong(data.name)}, your practice ${strong(data.companyName)} has been created.
          ${trial} Sign in to add your clients and work on their books from one place.`
    : `Hi ${strong(data.name)}, your account for ${strong(data.companyName)} has been created.
          ${trial} Sign in and start managing your accounts.`;

  const featureCols = FEATURES[data.variant].map((f) => `
    <td style="width:33%; padding:0 8px; text-align:center; vertical-align:top; font-family:${BRAND.fontStack};">
      <p style="margin:0 0 6px; font-size:24px;">${f.icon}</p>
      <p style="margin:0 0 4px; font-size:13px; font-weight:bold; color:${BRAND.textBody};">${f.title}</p>
      <p style="margin:0; font-size:12px; color:${BRAND.textSecondary}; line-height:1.5;">${f.desc}</p>
    </td>`).join('');

  const content = `
    <tr>
      <td style="padding:36px 32px 28px;">
        <h1 style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:24px;
                   font-weight:bold; color:${BRAND.textBody};">
          Welcome to IsaFlow!
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
        </table>
      </td>
    </tr>`;

  return emailLayout(content);
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
