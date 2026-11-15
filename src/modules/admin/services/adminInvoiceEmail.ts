/**
 * The email a platform (admin) invoice is sent as: subject + branded HTML summary (number, dates,
 * subtotal, VAT, total, notes). There is no PDF for platform invoices, so the body carries every figure.
 * Every value from the database is escaped; money and dates are formatted here, never passed through raw.
 */
import { BRAND, emailContentRow, emailLayout } from '@/lib/email-templates-shared';
import { formatDisplayDate } from '@/utils/dateFormat';
import { formatMoney } from '@/lib/money/formatMoney';

export interface AdminInvoiceEmailData {
  invoiceNumber: string;
  companyName: string;
  /** created_at: a Date from pg, or an ISO timestamp. */
  issuedAt: Date | string;
  /** due_date: ISO 'YYYY-MM-DD' (pg DATE parses to text here) or null. */
  dueDate: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string | null;
}

export const BILLING_CONTACT = 'accounts@isaflow.co.za';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 123456 cents -> "R 1 234.56" (the app's one money format). */
function rands(cents: number): string {
  return formatMoney(cents / 100);
}

function line(label: string, value: string, strong = false): string {
  const weight = strong ? 'font-weight:bold; font-size:16px;' : 'font-size:14px;';
  return `
        <tr>
          <td style="padding:6px 0; font-family:${BRAND.fontStack}; color:${BRAND.textSecondary}; ${weight}">${label}</td>
          <td align="right" style="padding:6px 0; font-family:${BRAND.fontStack}; color:${BRAND.textBody}; ${weight}">${value}</td>
        </tr>`;
}

export function adminInvoiceEmail(data: AdminInvoiceEmailData): { subject: string; html: string } {
  const number = escapeHtml(data.invoiceNumber);
  const issued = formatDisplayDate(data.issuedAt instanceof Date ? data.issuedAt.toISOString() : data.issuedAt);
  const due = data.dueDate ? formatDisplayDate(data.dueDate) : 'On receipt';
  const notes = data.notes && data.notes.trim()
    ? `<p style="margin:20px 0 0; font-family:${BRAND.fontStack}; font-size:14px; color:${BRAND.textSecondary}; line-height:1.6;">${escapeHtml(data.notes.trim()).replace(/\r?\n/g, '<br>')}</p>`
    : '';

  const inner = `
      <p style="margin:0 0 6px; font-size:12px; color:${BRAND.textMuted}; text-transform:uppercase; letter-spacing:0.05em;">Invoice</p>
      <h1 style="margin:0 0 8px; font-size:24px; font-weight:bold; color:${BRAND.textBody};">${number}</h1>
      <p style="margin:0 0 24px; font-size:15px; color:${BRAND.textSecondary}; line-height:1.6;">
        Dear <strong style="color:${BRAND.textBody};">${escapeHtml(data.companyName)}</strong>,<br>
        here is your IsaFlow invoice.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"
             style="border-top:1px solid ${BRAND.borderColor}; border-bottom:1px solid ${BRAND.borderColor};">
        ${line('Invoice date', issued)}
        ${line('Due date', due)}
        ${line('Subtotal', rands(data.subtotalCents))}
        ${line('VAT', rands(data.taxCents))}
        ${line('Total due', rands(data.totalCents), true)}
      </table>
      ${notes}
      <p style="margin:24px 0 0; font-size:14px; color:${BRAND.textSecondary}; line-height:1.6;">
        Please use <strong style="color:${BRAND.textBody};">${number}</strong> as your payment reference.
        Questions about this invoice: <a href="mailto:${BILLING_CONTACT}" style="color:${BRAND.primaryTeal};">${BILLING_CONTACT}</a>.
      </p>`;

  return { subject: `IsaFlow invoice ${data.invoiceNumber}`, html: emailLayout(emailContentRow(inner)) };
}
