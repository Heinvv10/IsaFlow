/**
 * ISAFlow Email Templates — Core (invite + invoice)
 * Table-based layout with inline styles for broad email client compatibility.
 * Welcome and password reset templates: src/lib/email-templates-auth.ts
 */

// ─── Brand Constants ──────────────────────────────────────────────────────────

export const BRAND = {
  logoUrl: 'https://app.isaflow.co.za/logo.png',
  appUrl: 'https://app.isaflow.co.za',
  primaryTeal: '#14b8a6',
  darkBg: '#0f172a',
  white: '#ffffff',
  cardBg: '#ffffff',
  outerBg: '#f1f5f9',
  footerBg: '#f8fafc',
  borderColor: '#e2e8f0',
  textBody: '#1e293b',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
  fontStack: 'Arial, Helvetica, sans-serif',
} as const;

// ─── Shared Layout ────────────────────────────────────────────────────────────

export function emailLayout(content: string): string {
  const header = `
    <tr>
      <td align="center" style="background-color:${BRAND.darkBg}; padding:28px 32px; border-bottom:3px solid ${BRAND.primaryTeal};">
        <a href="${BRAND.appUrl}" style="text-decoration:none;">
          <img src="${BRAND.logoUrl}" alt="ISAFlow" height="40"
               style="display:block; max-height:40px; width:auto; border:0;" />
        </a>
      </td>
    </tr>`;

  const footer = `
    <tr>
      <td style="background-color:${BRAND.footerBg}; padding:20px 32px; border-top:1px solid ${BRAND.borderColor};">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>
            <td style="font-family:${BRAND.fontStack}; font-size:12px; color:${BRAND.textMuted}; line-height:1.5;">
              ISAFlow &#8212; South African Cloud Accounting<br>
              This is an automated email. Please do not reply directly.
            </td>
            <td align="right" style="font-family:${BRAND.fontStack}; font-size:12px; color:${BRAND.textMuted};">
              <a href="${BRAND.appUrl}" style="color:${BRAND.primaryTeal}; text-decoration:none;">app.isaflow.co.za</a>
            </td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:12px; font-family:${BRAND.fontStack}; font-size:11px; color:${BRAND.textMuted};">
              <a href="${BRAND.appUrl}/preferences" style="color:${BRAND.textMuted}; text-decoration:underline;">Manage email preferences</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="format-detection" content="telephone=no">
</head>
<body style="margin:0; padding:0; background-color:${BRAND.outerBg}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
         style="background-color:${BRAND.outerBg}; padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="max-width:600px; width:100%; background-color:${BRAND.cardBg};
                      border-radius:8px; overflow:hidden;
                      box-shadow:0 4px 16px rgba(0,0,0,0.10);">
          ${header}
          ${content}
          ${footer}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── CTA Button Helper ────────────────────────────────────────────────────────

export function ctaButton(label: string, url: string): string {
  // VML fallback ensures button renders correctly in Outlook
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:8px 0 24px;">
      <tr>
        <td align="center">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="${url}" style="height:48px; v-text-anchor:middle; width:200px;" arcsize="12%"
            stroke="f" fillcolor="${BRAND.primaryTeal}">
            <w:anchorlock/>
            <center style="color:${BRAND.white}; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold;">${label}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${url}"
             style="display:inline-block; background-color:${BRAND.primaryTeal}; color:${BRAND.white};
                    font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:bold;
                    padding:14px 36px; border-radius:6px; text-decoration:none; mso-hide:all;">
            ${label}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

// ─── Invite Email ─────────────────────────────────────────────────────────────

export interface InviteEmailData {
  inviterName: string;
  companyName: string;
  role: string;
  inviteUrl: string;
  recipientEmail: string;
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
          <strong style="color:${BRAND.textBody};">${data.inviterName}</strong> has invited
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
                    ${data.companyName}
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
                    ${data.role}
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

// ─── Invoice Email ────────────────────────────────────────────────────────────

export interface InvoiceEmailData {
  invoiceNumber: string;
  clientName: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: string;
  balanceDue: string;
  companyName: string;
  portalUrl?: string;
}

export function invoiceEmailHtml(data: InvoiceEmailData): string {
  const divider = `
    <tr>
      <td colspan="2" style="padding:10px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr><td style="border-top:1px solid ${BRAND.borderColor}; height:1px; line-height:1px;">&nbsp;</td></tr>
        </table>
      </td>
    </tr>`;

  const content = `
    <tr>
      <td style="padding:36px 32px 28px;">
        <p style="margin:0 0 6px; font-family:${BRAND.fontStack}; font-size:12px;
                  color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">
          New Invoice
        </p>
        <h1 style="margin:0 0 8px; font-family:${BRAND.fontStack}; font-size:24px;
                   font-weight:bold; color:${BRAND.textBody};">
          ${data.invoiceNumber}
        </h1>
        <p style="margin:0 0 28px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Dear <strong style="color:${BRAND.textBody};">${data.clientName}</strong>,<br>
          please find your invoice attached. A summary is shown below.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
               style="background-color:${BRAND.outerBg}; border:1px solid ${BRAND.borderColor};
                      border-radius:6px; margin-bottom:28px;">
          <tr>
            <td style="padding:20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
                <tr>
                  <td style="width:50%; padding:4px 0; font-family:${BRAND.fontStack};">
                    <span style="font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Invoice #</span><br>
                    <span style="font-size:15px; font-weight:bold; color:${BRAND.textBody};">${data.invoiceNumber}</span>
                  </td>
                  <td style="width:50%; padding:4px 0; font-family:${BRAND.fontStack};" align="right">
                    <span style="font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Invoice Date</span><br>
                    <span style="font-size:15px; color:${BRAND.textBody};">${data.invoiceDate}</span>
                  </td>
                </tr>
                ${divider}
                <tr>
                  <td style="width:50%; padding:4px 0; font-family:${BRAND.fontStack};">
                    <span style="font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Due Date</span><br>
                    <span style="font-size:15px; color:${BRAND.textBody};">${data.dueDate}</span>
                  </td>
                  <td style="width:50%; padding:4px 0; font-family:${BRAND.fontStack};" align="right">
                    <span style="font-size:11px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Balance Due</span><br>
                    <span style="font-size:22px; font-weight:bold; color:${BRAND.primaryTeal};">${data.balanceDue}</span>
                  </td>
                </tr>
                ${divider}
                <tr>
                  <td style="font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textSecondary};">Total Amount</td>
                  <td align="right" style="font-family:${BRAND.fontStack}; font-size:13px; color:${BRAND.textSecondary};">${data.totalAmount}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        ${data.portalUrl ? ctaButton('View Invoice', data.portalUrl) : ''}
        <p style="margin:0 0 16px; font-family:${BRAND.fontStack}; font-size:14px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          The full invoice is attached as a PDF. Please use
          <strong style="color:${BRAND.textBody};">${data.invoiceNumber}</strong>
          as your payment reference.
        </p>
        <p style="margin:0; font-family:${BRAND.fontStack}; font-size:14px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          If you have any questions, please contact
          <strong style="color:${BRAND.textBody};">${data.companyName}</strong> directly.
        </p>
      </td>
    </tr>`;

  return emailLayout(content);
}
