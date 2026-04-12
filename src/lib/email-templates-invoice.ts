/**
 * ISAFlow Email Templates — Invoice
 * Split from email-templates.ts to stay within the 300-line limit.
 */

import { BRAND, emailLayout, ctaButton } from './email-templates-shared';

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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
          ${escapeHtml(data.invoiceNumber)}
        </h1>
        <p style="margin:0 0 28px; font-family:${BRAND.fontStack}; font-size:15px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          Dear <strong style="color:${BRAND.textBody};">${escapeHtml(data.clientName)}</strong>,<br>
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
                    <span style="font-size:15px; font-weight:bold; color:${BRAND.textBody};">${escapeHtml(data.invoiceNumber)}</span>
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
          <strong style="color:${BRAND.textBody};">${escapeHtml(data.invoiceNumber)}</strong>
          as your payment reference.
        </p>
        <p style="margin:0; font-family:${BRAND.fontStack}; font-size:14px;
                  color:${BRAND.textSecondary}; line-height:1.6;">
          If you have any questions, please contact
          <strong style="color:${BRAND.textBody};">${escapeHtml(data.companyName)}</strong> directly.
        </p>
      </td>
    </tr>`;

  return emailLayout(content);
}
