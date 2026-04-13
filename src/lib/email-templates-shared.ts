/**
 * ISAFlow Email Templates — Shared Helpers
 * Brand constants, layout wrapper, CTA button, and signature helpers.
 * Split from email-templates.ts to stay within the 300-line limit.
 */

// ─── Signature Helper ─────────────────────────────────────────────────────────

/**
 * Appends a per-document-type HTML signature block below the email body.
 * Injected just before </body> so it sits outside the card layout.
 * The signature is stored as user-entered HTML in company settings.
 * Returns html unchanged when signature is null/empty.
 */
export function appendSignatureToHtml(html: string, signature: string | null | undefined): string {
  if (!signature || !signature.trim()) return html;
  const signatureBlock = `
<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
       style="max-width:600px; margin:16px auto 0; padding:0 16px;">
  <tr>
    <td style="font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#64748b;
               line-height:1.6; padding:12px 0; border-top:1px solid #e2e8f0;">
      ${signature}
    </td>
  </tr>
</table>`;
  return html.replace('</body>', `${signatureBlock}\n</body>`);
}

// ─── Brand Constants ──────────────────────────────────────────────────────────

export const BRAND = {
  logoUrl: 'cid:isaflow-logo@isaflow.co.za',
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
