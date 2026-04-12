/**
 * ISAFlow Email Templates — Invite
 * Split from email-templates.ts to stay within the 300-line limit.
 */

import { BRAND, emailLayout, ctaButton } from './email-templates-shared';

// ─── Invite Email ─────────────────────────────────────────────────────────────

export interface InviteEmailData {
  inviterName: string;
  companyName: string;
  role: string;
  inviteUrl: string;
  recipientEmail: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function inviteEmailHtml(data: InviteEmailData): string {
  const content = `
    <tr>
      <td style="padding:36px 32px 28px;">
        <h1 style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:24px;
                   font-weight:bold; color:${BRAND.textBody};">
          You&#8217;re Invited!
        </h1>
        <p style="margin:0 0 24px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          <strong style="color:${BRAND.textBody};">${escapeHtml(data.inviterName)}</strong> has invited
          you to join their organisation on ISAFlow.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="background-color:${BRAND.outerBg}; border:1px solid ${BRAND.borderColor};
                      border-radius:6px; margin-bottom:28px;">
          <tr>
            <td style="padding:20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                <tr>
                  <td style="padding:6px 0; font-family:${BRAND.fontStack}; font-size:12px;
                             color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
                    Organisation
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 14px; font-family:${BRAND.fontStack}; font-size:15px;
                             font-weight:bold; color:${BRAND.textBody}; border-bottom:1px solid ${BRAND.borderColor};">
                    ${escapeHtml(data.companyName)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                             color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
                    Your Role
                  </td>
                </tr>
                <tr>
                  <td style="font-family:${BRAND.fontStack}; font-size:15px;
                             font-weight:bold; color:${BRAND.primaryTeal};">
                    ${escapeHtml(data.role)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${ctaButton('Accept Invitation', data.inviteUrl)}
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textMuted}; text-align:center;">
          Or copy this link:
        </p>
        <p style="margin:0 0 24px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textSecondary}; text-align:center; word-break:break-all;">
          <a href="${data.inviteUrl}" style="color:${BRAND.primaryTeal}; text-decoration:none;">${data.inviteUrl}</a>
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="border-top:1px solid ${BRAND.borderColor};">
          <tr>
            <td style="padding-top:20px; font-family:${BRAND.fontStack}; font-size:13px;
                       font-weight:bold; color:${BRAND.textSecondary}; line-height:1.6;">
              This invitation expires in 7 days.
            </td>
          </tr>
          <tr>
            <td style="padding-top:8px; font-family:${BRAND.fontStack}; font-size:13px;
                       color:${BRAND.textMuted}; line-height:1.6;">
              If you didn&#8217;t expect this invitation, you can safely ignore this email.
              Your account will not be affected.
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  return emailLayout(content);
}
