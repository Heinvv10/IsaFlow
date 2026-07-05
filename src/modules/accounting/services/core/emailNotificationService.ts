/**
 * Email Notification Service
 * Invoice and invite email sending — split from emailService.ts.
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { generateInvoicePdf } from '../ar/invoicePdfService';
import { inviteEmailHtml, invoiceEmailHtml, appendSignatureToHtml } from '@/lib/email-templates';
import type { InviteEmailData, InvoiceEmailData } from '@/lib/email-templates';
import { fireWebhook } from './webhookService';
import { sendEmail } from './emailService';
import type { EmailResult } from './emailService';
import type { DbRow } from '@/types/db';


const fmtZAR = (amount: number): string =>
  'R ' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const parts = d.split('T')[0]?.split('-') ?? [];
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
};

export async function sendInvoiceEmail(
  companyId: string,
  invoiceId: string,
  recipientEmail: string,
): Promise<EmailResult> {
  const [invoiceRows, companyRows] = await Promise.all([
    sql`
      SELECT ci.invoice_number, ci.invoice_date, ci.due_date,
             ci.total_amount, ci.amount_paid,
             c.name AS client_name
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      WHERE ci.id = ${invoiceId}::UUID
        AND ci.company_id = ${companyId}::UUID
    ` as Promise<DbRow[]>,
    sql`
      SELECT name, invoice_email_signature
      FROM companies
      WHERE id = ${companyId}::UUID
    ` as Promise<DbRow[]>,
  ]);

  if (invoiceRows.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  const invoiceRow = invoiceRows[0]!;
  const companyRow = companyRows[0] ?? {};
  const invoice = {
    invoice_number: String(invoiceRow.invoice_number ?? ''),
    invoice_date: invoiceRow.invoice_date != null ? String(invoiceRow.invoice_date) : null,
    due_date: invoiceRow.due_date != null ? String(invoiceRow.due_date) : null,
    total_amount: Number(invoiceRow.total_amount),
    amount_paid: Number(invoiceRow.amount_paid ?? 0),
    client_name: invoiceRow.client_name != null ? String(invoiceRow.client_name) : null,
  };
  const balance = invoice.total_amount - invoice.amount_paid;
  const companyName = companyRow.name != null ? String(companyRow.name) : 'IsaFlow';
  const invoiceSignature = companyRow.invoice_email_signature != null
    ? String(companyRow.invoice_email_signature)
    : null;

  const pdfBuffer = await generateInvoicePdf(companyId, invoiceId);

  const invoiceData: InvoiceEmailData = {
    invoiceNumber: invoice.invoice_number,
    clientName: invoice.client_name || 'Valued Customer',
    invoiceDate: fmtDate(invoice.invoice_date),
    dueDate: fmtDate(invoice.due_date),
    totalAmount: fmtZAR(invoice.total_amount),
    balanceDue: fmtZAR(balance),
    companyName,
  };
  const html = appendSignatureToHtml(invoiceEmailHtml(invoiceData), invoiceSignature);

  const result = await sendEmail({
    to: recipientEmail,
    subject: `Invoice ${invoice.invoice_number} from ${companyName}`,
    html,
    attachments: [
      {
        filename: `${invoice.invoice_number || 'Invoice'}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
    _log: { companyId, emailType: 'invoice' },
  });

  if (result.success) {
    await sql`
      UPDATE customer_invoices
      SET email_sent_at = NOW(),
          email_sent_to = ${recipientEmail},
          email_message_id = ${result.messageId || null},
          updated_at = NOW()
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;

    log.info('Invoice email sent and tracked', {
      invoiceId,
      recipientEmail,
      messageId: result.messageId,
    }, 'emailService');

    void fireWebhook(companyId, 'invoice.sent', {
      invoiceId,
      invoiceNumber: invoice.invoice_number,
      totalAmount: invoice.total_amount,
      recipientEmail,
    });
  }

  return result;
}

export interface InviteEmailOptions {
  recipientEmail: string;
  inviteToken: string;
  companyName: string;
  inviterName: string;
  role: string;
  baseUrl: string;
}

export async function sendInviteEmail(options: InviteEmailOptions): Promise<EmailResult> {
  const inviteUrl = `${options.baseUrl}/invite/${options.inviteToken}`;

  const inviteData: InviteEmailData = {
    inviterName: options.inviterName,
    companyName: options.companyName,
    role: options.role,
    inviteUrl,
    recipientEmail: options.recipientEmail,
  };

  return sendEmail({
    to: options.recipientEmail,
    subject: `You've been invited to join ${options.companyName} on ISAFlow`,
    html: inviteEmailHtml(inviteData),
    _log: { companyId: null, emailType: 'invite' },
  });
}
