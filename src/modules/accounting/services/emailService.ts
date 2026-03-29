/**
 * Email Service
 * Generic email sending via SMTP (nodemailer) + invoice-specific helpers
 * Gracefully handles missing SMTP configuration
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { generateInvoicePdf } from './invoicePdfService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─── SMTP Configuration ────────────────────────────────────────────────────

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || 'accounts@isaflow.co.za';

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port: port ? parseInt(port, 10) : 587,
    user,
    pass,
    from,
  };
}

// ─── Generic Email Sender ───────────────────────────────────────────────────

export async function sendEmail(options: EmailOptions): Promise<EmailResult> {
  const config = getSmtpConfig();

  if (!config) {
    log.warn('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.', {}, 'emailService');
    return { success: false, error: 'SMTP not configured' };
  }

  try {
    // Dynamic import to avoid loading nodemailer when not needed
    const nodemailer = await import('nodemailer');

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mailOptions: any = {
      from: config.from,
      to: recipients,
      subject: options.subject,
      html: options.html,
      attachments: options.attachments?.map((att) => ({
        filename: att.filename,
        content: att.content,
        contentType: att.contentType,
      })),
    };

    const info = await transporter.sendMail(mailOptions);

    log.info('Email sent', {
      messageId: info.messageId,
      to: recipients,
      subject: options.subject,
    }, 'emailService');

    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown email error';
    log.error('Failed to send email', { error: message, to: options.to }, 'emailService');
    return { success: false, error: message };
  }
}

// ─── Invoice Email ──────────────────────────────────────────────────────────

const fmtZAR = (amount: number): string =>
  'R ' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const parts = d.split('T')[0]?.split('-') ?? [];
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
};

export async function sendInvoiceEmail(companyId: string, 
  invoiceId: string,
  recipientEmail: string
): Promise<EmailResult> {
  // Fetch invoice summary for email body
  const invoiceRows = (await sql`
    SELECT ci.invoice_number, ci.invoice_date, ci.due_date,
           ci.total_amount, ci.amount_paid,
           c.company_name AS client_name
    FROM customer_invoices ci
    LEFT JOIN clients c ON c.id = ci.client_id
    WHERE ci.id = ${invoiceId}::UUID
  `) as Row[];

  if (invoiceRows.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  const invoice = invoiceRows[0];
  const balance = Number(invoice.total_amount) - Number(invoice.amount_paid || 0);
  const companyName = 'IsaFlow';

  // Generate PDF
  const pdfBuffer = await generateInvoicePdf('', invoiceId);

  // Build email HTML (table-based for email client compatibility)
  const html = buildInvoiceEmailHtml({
    invoiceNumber: invoice.invoice_number,
    clientName: invoice.client_name || 'Valued Customer',
    invoiceDate: fmtDate(invoice.invoice_date),
    dueDate: fmtDate(invoice.due_date),
    totalAmount: fmtZAR(Number(invoice.total_amount)),
    balanceDue: fmtZAR(balance),
    companyName,
  });

  // Send email with PDF attachment
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
  });

  // Update tracking fields on the invoice
  if (result.success) {
    await sql`
      UPDATE customer_invoices
      SET email_sent_at = NOW(),
          email_sent_to = ${recipientEmail},
          email_message_id = ${result.messageId || null},
          updated_at = NOW()
      WHERE id = ${invoiceId}::UUID
    `;

    log.info('Invoice email sent and tracked', {
      invoiceId,
      recipientEmail,
      messageId: result.messageId,
    }, 'emailService');
  }

  return result;
}

// ─── Email HTML Template ────────────────────────────────────────────────────

interface InvoiceEmailData {
  invoiceNumber: string;
  clientName: string;
  invoiceDate: string;
  dueDate: string;
  totalAmount: string;
  balanceDue: string;
  companyName: string;
}

function buildInvoiceEmailHtml(data: InvoiceEmailData): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${data.invoiceNumber}</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f7; font-family:Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7; padding:20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color:#14b8a6; padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <h1 style="margin:0; color:#ffffff; font-size:24px; font-weight:bold;">${data.companyName}</h1>
                  </td>
                  <td align="right">
                    <span style="color:#ffffff; font-size:14px; opacity:0.9;">TAX INVOICE</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px; color:#333333; font-size:16px;">
                Dear ${data.clientName},
              </p>
              <p style="margin:0 0 24px; color:#555555; font-size:14px; line-height:1.6;">
                Please find attached invoice <strong>${data.invoiceNumber}</strong> for your records.
                We appreciate your continued business.
              </p>

              <!-- Invoice Summary Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafb; border:1px solid #e5e7eb; border-radius:6px; margin-bottom:24px;">
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:4px 0;">
                          <span style="color:#888888; font-size:12px; text-transform:uppercase;">Invoice Number</span><br>
                          <span style="color:#333333; font-size:15px; font-weight:bold;">${data.invoiceNumber}</span>
                        </td>
                        <td align="right" style="padding:4px 0;">
                          <span style="color:#888888; font-size:12px; text-transform:uppercase;">Invoice Date</span><br>
                          <span style="color:#333333; font-size:15px;">${data.invoiceDate}</span>
                        </td>
                      </tr>
                      <tr>
                        <td colspan="2" style="padding:8px 0 0;">
                          <hr style="border:none; border-top:1px solid #e5e7eb; margin:0;">
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0 4px;">
                          <span style="color:#888888; font-size:12px; text-transform:uppercase;">Due Date</span><br>
                          <span style="color:#333333; font-size:15px;">${data.dueDate}</span>
                        </td>
                        <td align="right" style="padding:8px 0 4px;">
                          <span style="color:#888888; font-size:12px; text-transform:uppercase;">Amount Due</span><br>
                          <span style="color:#14b8a6; font-size:20px; font-weight:bold;">${data.balanceDue}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px; color:#555555; font-size:14px; line-height:1.6;">
                The full invoice is attached as a PDF document. Please use invoice number
                <strong>${data.invoiceNumber}</strong> as your payment reference.
              </p>

              <p style="margin:0 0 8px; color:#555555; font-size:14px;">
                If you have any questions regarding this invoice, please do not hesitate to contact us.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8fafb; padding:20px 32px; border-top:1px solid #e5e7eb;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0; color:#999999; font-size:12px;">
                      ${data.companyName}<br>
                      This is an automated email. Please do not reply directly.
                    </p>
                  </td>
                  <td align="right">
                    <p style="margin:0; color:#bbbbbb; font-size:11px;">
                      Generated by IsaFlow
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
