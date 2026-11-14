/**
 * Emailing a platform invoice to the company's billing email (admin "Send"), in three committed steps,
 * none of them held open across the SMTP call (migration 991, review of #1368 M1/M2):
 *
 *   1. claimInvoiceForSend   own transaction: a draft with no claim gets send_claimed_at = now() and an
 *                            `invoice.send_started` audit row. COMMITTED before the email.
 *   2. emailInvoice          outside every transaction; sendEmail writes the email_log row on autocommit,
 *                            so no later rollback can erase the record of an email that left. SMTP is
 *                            bounded (SMTP_TIMEOUTS_MS).
 *   3. finaliseInvoiceSent   own transaction: status 'sent', claim cleared, `invoice.send` audit row.
 *      releaseInvoiceClaim   or, when the mail server refused it: claim cleared, `invoice.send_failed`.
 *
 * A Send on a claimed invoice is refused: another send is in flight, or one's outcome is unknown. When
 * the email left but step 3 failed, the claim STAYS, so the invoice is never re-sent automatically; an
 * operator reads the email log (email_type 'invoice', the invoice number in the subject) and settles it.
 */
import { z } from 'zod';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withOwnPlatformAdminTx } from '@/lib/auth/platformAdminOwnTx';
import { sendEmail, type EmailResult } from '@/modules/accounting/services/core/emailService';
import { logAdminAction } from './auditService';
import { adminInvoiceEmail } from './adminInvoiceEmail';

/** connection / greeting / socket inactivity, ms: an admin is waiting on the answer. */
export const SMTP_TIMEOUTS_MS = { connection: 15_000, greeting: 15_000, socket: 20_000 } as const;

export interface InvoiceForSend {
  id: string;
  company_id: string;
  company_name: string;
  billing_email: string;
  invoice_number: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  due_date: string | null;
  created_at: Date | string;
  notes: string | null;
}

export type SendClaim =
  | { ok: true; invoice: InvoiceForSend }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'wrong_status'; status: string; invoice_number: string }
  | { ok: false; reason: 'in_progress'; invoice_number: string }
  | { ok: false; reason: 'no_billing_email'; company_name: string };

export interface SendActor { userId: string; claims: Record<string, unknown>; ip: string | null }

/** One address, not a list: a comma in companies.billing_email would otherwise mail several people. */
export function isSingleEmailAddress(value: string): boolean {
  return z.email().safeParse(value).success;
}

/** Step 1. Refusals write nothing; a claim commits with its audit row before this returns. */
export async function claimInvoiceForSend(invoiceId: string, actor: SendActor): Promise<SendClaim> {
  return withOwnPlatformAdminTx(actor, async () => {
    await sql`SET LOCAL lock_timeout = '5s'`;
    const rows = (await sql`
      SELECT i.id, i.company_id, c.name AS company_name, c.billing_email, i.invoice_number, i.status,
             i.send_claimed_at, i.subtotal_cents, i.tax_cents, i.total_cents, i.due_date, i.created_at, i.notes
      FROM admin_invoices i
      INNER JOIN companies c ON c.id = i.company_id
      WHERE i.id = ${invoiceId}::uuid
      FOR UPDATE OF i
    `) as DbRow[];
    const r = rows[0];
    if (!r) return { ok: false, reason: 'not_found' };
    const invoiceNumber = String(r.invoice_number);
    if (r.send_claimed_at != null) return { ok: false, reason: 'in_progress', invoice_number: invoiceNumber };
    if (r.status !== 'draft') return { ok: false, reason: 'wrong_status', status: String(r.status), invoice_number: invoiceNumber };
    const email = typeof r.billing_email === 'string' ? r.billing_email.trim() : '';
    if (!email || !isSingleEmailAddress(email)) return { ok: false, reason: 'no_billing_email', company_name: String(r.company_name ?? '') };

    await sql`UPDATE admin_invoices SET send_claimed_at = NOW() WHERE id = ${invoiceId}::uuid`;
    const invoice: InvoiceForSend = {
      id: String(r.id), company_id: String(r.company_id), company_name: String(r.company_name ?? ''),
      billing_email: email, invoice_number: invoiceNumber,
      subtotal_cents: Number(r.subtotal_cents), tax_cents: Number(r.tax_cents), total_cents: Number(r.total_cents),
      due_date: r.due_date == null ? null : String(r.due_date), created_at: r.created_at as Date | string,
      notes: r.notes == null ? null : String(r.notes),
    };
    await logAdminAction(actor.userId, 'invoice.send_started', 'invoice', invoiceId,
      { recipient: email, invoice_number: invoiceNumber, total_cents: invoice.total_cents }, actor.ip);
    return { ok: true, invoice };
  });
}

/** Step 2. Outside every transaction: the email_log row sendEmail writes commits at once. */
export async function emailInvoice(invoice: InvoiceForSend, sentBy: string): Promise<EmailResult> {
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
  return als.exit(() => sendEmail({
    to: invoice.billing_email,
    subject,
    html,
    smtpTimeoutsMs: SMTP_TIMEOUTS_MS,
    _log: { companyId: invoice.company_id, emailType: 'invoice', sentBy },
  }));
}

/** Step 3, the email left. Throws when the claimed draft is not there to finalise: the claim then stays. */
export async function finaliseInvoiceSent(invoice: InvoiceForSend, actor: SendActor, messageId: string | null): Promise<void> {
  await withOwnPlatformAdminTx(actor, async () => {
    const rows = await sql`
      UPDATE admin_invoices SET status = 'sent', send_claimed_at = NULL
      WHERE id = ${invoice.id}::uuid AND status = 'draft' AND send_claimed_at IS NOT NULL
      RETURNING id
    `;
    if (rows.length === 0) {
      throw new Error(`finaliseInvoiceSent: ${invoice.invoice_number} is no longer a claimed draft; the email left, the claim was not settled`);
    }
    await logAdminAction(actor.userId, 'invoice.send', 'invoice', invoice.id,
      { recipient: invoice.billing_email, invoice_number: invoice.invoice_number, message_id: messageId }, actor.ip);
  });
  log.info('finaliseInvoiceSent', { invoiceId: invoice.id }, 'InvoiceSendService');
}

/** Step 3, the mail server refused it (nothing left): the claim is released for a later retry. */
export async function releaseInvoiceClaim(invoice: InvoiceForSend, actor: SendActor, error: string): Promise<void> {
  await withOwnPlatformAdminTx(actor, async () => {
    await sql`UPDATE admin_invoices SET send_claimed_at = NULL WHERE id = ${invoice.id}::uuid AND status = 'draft'`;
    await logAdminAction(actor.userId, 'invoice.send_failed', 'invoice', invoice.id,
      { recipient: invoice.billing_email, invoice_number: invoice.invoice_number, error }, actor.ip);
  });
}
