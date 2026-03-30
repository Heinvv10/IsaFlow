/**
 * ISAFlow Email Templates — Auth (welcome + password reset)
 * Table-based layout with inline styles for broad email client compatibility.
 * Core templates (invite + invoice): src/lib/email-templates.ts
 */

import { BRAND, emailLayout, ctaButton } from '@/lib/email-templates';

// ─── Welcome Email ────────────────────────────────────────────────────────────

export interface WelcomeEmailData {
  name: string;
  email: string;
  companyName: string;
}

export function welcomeEmailHtml(data: WelcomeEmailData): string {
  const features: Array<{ icon: string; title: string; desc: string }> = [
    { icon: '&#128203;', title: 'Invoicing', desc: 'Create and send professional invoices in seconds.' },
    { icon: '&#127968;', title: 'Banking', desc: 'Reconcile transactions with your bank feeds.' },
    { icon: '&#128200;', title: 'Reports', desc: 'Income statements, balance sheets and more.' },
  ];

  const featureCols = features.map((f) => `
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
          Welcome to ISAFlow!
        </h1>
        <p style="margin:0 0 24px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Hi <strong style="color:${BRAND.textBody};">${data.name}</strong>, your account
          for <strong style="color:${BRAND.textBody};">${data.companyName}</strong> has been
          created. You&#8217;re ready to start managing your accounts.
        </p>
        ${ctaButton('Get Started', BRAND.appUrl)}
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
          we received a request to reset the password for your ISAFlow account.
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
