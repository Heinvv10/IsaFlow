/**
 * Email Service
 * Generic email sending via SMTP (nodemailer) + invoice-specific helpers
 * Gracefully handles missing SMTP configuration
 */

import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { generateInvoicePdf } from './invoicePdfService';
import { inviteEmailHtml, invoiceEmailHtml } from '@/lib/email-templates';
import type { InviteEmailData, InvoiceEmailData } from '@/lib/email-templates';
type Row = Record<string, unknown>;


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
      tls: {
        // Allow self-signed certs in dev; enforce TLS validation in production
        rejectUnauthorized: process.env.NODE_ENV === 'production',
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
           c.name AS client_name
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = ci.client_id
    WHERE ci.id = ${invoiceId}::UUID
  `) as Row[];

  if (invoiceRows.length === 0) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  const invoiceRow = invoiceRows[0]!;
  const invoice = {
    invoice_number: String(invoiceRow.invoice_number ?? ''),
    invoice_date: invoiceRow.invoice_date != null ? String(invoiceRow.invoice_date) : null,
    due_date: invoiceRow.due_date != null ? String(invoiceRow.due_date) : null,
    total_amount: Number(invoiceRow.total_amount),
    amount_paid: Number(invoiceRow.amount_paid ?? 0),
    client_name: invoiceRow.client_name != null ? String(invoiceRow.client_name) : null,
  };
  const balance = invoice.total_amount - invoice.amount_paid;
  const companyName = 'IsaFlow';

  // Generate PDF
  const pdfBuffer = await generateInvoicePdf('', invoiceId);

  // Build email HTML (table-based for email client compatibility)
  const invoiceData: InvoiceEmailData = {
    invoiceNumber: invoice.invoice_number,
    clientName: invoice.client_name || 'Valued Customer',
    invoiceDate: fmtDate(invoice.invoice_date),
    dueDate: fmtDate(invoice.due_date),
    totalAmount: fmtZAR(invoice.total_amount),
    balanceDue: fmtZAR(balance),
    companyName,
  };
  const html = invoiceEmailHtml(invoiceData);

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

// ─── Invite Email ───────────────────────────────────────────────────────────

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
  });
}

