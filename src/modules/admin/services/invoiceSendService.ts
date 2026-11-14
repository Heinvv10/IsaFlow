/**
 * Emailing a platform invoice to the company's billing email (admin "Send").
 *
 * Runs inside the admin request transaction (withPlatformAdmin). The route's order is:
 *   lockInvoiceForSend (FOR UPDATE: a second Send waits, then sees 'sent' and is refused)
 *   -> the audit row -> emailInvoice -> markInvoiceSent only when the mail server took it.
 * The status never says 'sent' for an invoice whose email did not go out. The one gap left is a COMMIT
 * that fails after the email left: the invoice stays draft and the admin sees a 500.
 */
import { z } from 'zod';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail, type EmailResult } from '@/modules/accounting/services/core/emailService';
import { adminInvoiceEmail } from './adminInvoiceEmail';

export interface InvoiceForSend {
  id: string;
  company_id: string;
  company_name: string;
  billing_email: string | null;
  invoice_number: string;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  due_date: string | null;
  created_at: Date | string;
  notes: string | null;
}

/** The invoice and its company's billing email, row-locked for the rest of the request; null when there is none. */
export async function lockInvoiceForSend(invoiceId: string): Promise<InvoiceForSend | null> {
  const rows = (await sql`
    SELECT i.id, i.company_id, c.name AS company_name, c.billing_email,
           i.invoice_number, i.status, i.subtotal_cents, i.tax_cents, i.total_cents,
           i.due_date, i.created_at, i.notes
    FROM admin_invoices i
    INNER JOIN companies c ON c.id = i.company_id
    WHERE i.id = ${invoiceId}::uuid
    FOR UPDATE OF i
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const email = typeof r.billing_email === 'string' ? r.billing_email.trim() : '';
  return {
    id: String(r.id),
    company_id: String(r.company_id),
    company_name: String(r.company_name ?? ''),
    billing_email: email || null,
    invoice_number: String(r.invoice_number),
    status: String(r.status),
    subtotal_cents: Number(r.subtotal_cents),
    tax_cents: Number(r.tax_cents),
    total_cents: Number(r.total_cents),
    due_date: r.due_date == null ? null : String(r.due_date),
    created_at: r.created_at as Date | string,
    notes: r.notes == null ? null : String(r.notes),
  };
}

/** One address, not a list: a comma in companies.billing_email would otherwise mail several people. */
export function isSingleEmailAddress(value: string): boolean {
  return z.email().safeParse(value).success;
}

/** Sends through the app's mail sender, which writes the email_log row (sent or failed) itself. */
export async function emailInvoice(invoice: InvoiceForSend & { billing_email: string }, sentBy: string): Promise<EmailResult> {
  const { subject, html } = adminInvoiceEmail({
    invoiceNumber: invoice.invoice_number,
    companyName: invoice.company_name,
    issuedAt: invoice.created_at,
    dueDate: invoice.due_date,
    subtotalCents: invoice.subtotal_cents,
    taxCents: invoice.tax_cents,
    totalCents: invoice.total_cents,
    notes: invoice.notes,
  });
  return sendEmail({
    to: invoice.billing_email,
    subject,
    html,
    _log: { companyId: invoice.company_id, emailType: 'invoice', sentBy },
  });
}

/** draft -> sent, after the email went out. False when the row is no longer draft (cannot happen under the lock). */
export async function markInvoiceSent(invoiceId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE admin_invoices SET status = 'sent'
    WHERE id = ${invoiceId}::uuid AND status = 'draft'
    RETURNING id
  `;
  log.info('markInvoiceSent', { invoiceId, updated: rows.length > 0 }, 'InvoiceSendService');
  return rows.length > 0;
}
