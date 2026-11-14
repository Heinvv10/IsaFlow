/**
 * Emailing a platform invoice to the company's billing email (admin "Send"), in three committed steps
 * (migration 993, reviews of #1368). Each step commits on its own one-off platform_admin connection
 * (withOwnPlatformAdminTx). The request's own withPlatformAdmin transaction and its pool connection stay
 * open, idle, across the SMTP call, but hold no row lock and no write of this flow:
 *
 *   1. claimInvoiceForSend   own transaction: a draft with no claim, whose billing email is still the one the
 *                            admin confirmed, gets send_claimed_at = now() and an `invoice.send_started` audit
 *                            row. COMMITTED before the email.
 *   2. emailInvoice          outside every transaction; sendEmail writes the email_log row on autocommit,
 *                            so no later rollback can erase the record of an email that left. SMTP is
 *                            bounded: SMTP_TIMEOUTS_MS (inactivity) and SEND_DEADLINE_MS (hard ceiling: the transport
 *                            is closed and the outcome is unknown). A throw while preparing the email (before sendEmail
 *                            runs) is InvoiceEmailNotStartedError: nothing left, and the route releases the claim.
 *   3. finaliseInvoiceSent   own transaction: status 'sent', claim cleared, `invoice.send` audit row.
 *      releaseInvoiceClaim   or, when nothing left: claim cleared, `invoice.send_failed`.
 *
 * A Send on a claimed invoice is refused: another send is in flight, or one's outcome is unknown. When
 * the email may have left but step 3 did not run, the claim STAYS, so the invoice is never re-sent
 * automatically. The list shows it ("Sending…", then "outcome unknown" once SEND_SETTLE_AFTER_MS has passed) and an
 * admin settles it after reading the email log (settleInvoiceSend: mark it sent, or release it unsent), audited
 * `invoice.send_settled`; a younger claim cannot be settled.
 */
import { z } from 'zod';
import { als, requireCtx } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { withOwnPlatformAdminTx } from '@/lib/auth/platformAdminOwnTx';
import { sendEmail, type EmailResult } from '@/modules/accounting/services/core/emailService';
import { logAdminAction } from './auditService';
import { adminInvoiceEmail } from './adminInvoiceEmail';
import { SEND_DEADLINE_MS, SEND_SETTLE_AFTER_MS, SMTP_TIMEOUTS_MS } from './invoiceSendTiming';


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
  | { ok: false; reason: 'no_billing_email'; company_name: string }
  | { ok: false; reason: 'recipient_changed'; billing_email: string };

/** Thrown by emailInvoice when it failed BEFORE sendEmail ran: provably nothing left. */
export class InvoiceEmailNotStartedError extends Error {
  constructor(cause: unknown) {
    super(`invoice email not prepared: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'InvoiceEmailNotStartedError';
  }
}

/** One address, not a list: a comma in companies.billing_email would otherwise mail several people. */
export function isSingleEmailAddress(value: string): boolean {
  return z.email().safeParse(value).success;
}

const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Step 1. Refusals write nothing; a claim commits with its audit row before this returns. */
export async function claimInvoiceForSend(invoiceId: string, confirmedTo: string, ip: string | null): Promise<SendClaim> {
  return withOwnPlatformAdminTx(async () => {
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
    // The address the admin saw in the confirm dialog: a billing email changed since then is not what they approved.
    if (!sameAddress(email, confirmedTo)) return { ok: false, reason: 'recipient_changed', billing_email: email };

    await sql`UPDATE admin_invoices SET send_claimed_at = NOW() WHERE id = ${invoiceId}::uuid`;
    const invoice: InvoiceForSend = {
      id: String(r.id), company_id: String(r.company_id), company_name: String(r.company_name ?? ''),
      billing_email: email, invoice_number: invoiceNumber,
      subtotal_cents: Number(r.subtotal_cents), tax_cents: Number(r.tax_cents), total_cents: Number(r.total_cents),
      due_date: r.due_date == null ? null : String(r.due_date), created_at: r.created_at as Date | string,
      notes: r.notes == null ? null : String(r.notes),
    };
    await logAdminAction(requireCtx().userId, 'invoice.send_started', 'invoice', invoiceId,
      { recipient: email, invoice_number: invoiceNumber, total_cents: invoice.total_cents }, ip);
    return { ok: true, invoice };
  });
}

/** Step 2. Outside every transaction: the email_log row sendEmail writes commits at once. */
export async function emailInvoice(invoice: InvoiceForSend, sentBy: string): Promise<EmailResult> {
  let message: { subject: string; html: string };
  try {
    message = adminInvoiceEmail({
      invoiceNumber: invoice.invoice_number,
      companyName: invoice.company_name,
      issuedAt: invoice.created_at,
      dueDate: invoice.due_date,
      subtotalCents: invoice.subtotal_cents,
      taxCents: invoice.tax_cents,
      totalCents: invoice.total_cents,
      notes: invoice.notes,
    });
  } catch (err) {
    throw new InvoiceEmailNotStartedError(err);
  }
  return als.exit(() => sendEmail({
    to: invoice.billing_email,
    subject: message.subject,
    html: message.html,
    smtpTimeoutsMs: SMTP_TIMEOUTS_MS,
    deadlineMs: SEND_DEADLINE_MS,
    _log: { companyId: invoice.company_id, emailType: 'invoice', sentBy },
  }));
}

/** Step 3, the email left. Throws when the claimed draft is not there to finalise: the claim then stays. */
export async function finaliseInvoiceSent(invoice: InvoiceForSend, ip: string | null, messageId: string | null): Promise<void> {
  await withOwnPlatformAdminTx(async () => {
    const rows = await sql`
      UPDATE admin_invoices SET status = 'sent', send_claimed_at = NULL
      WHERE id = ${invoice.id}::uuid AND status = 'draft' AND send_claimed_at IS NOT NULL
      RETURNING id
    `;
    if (rows.length === 0) {
      throw new Error(`finaliseInvoiceSent: ${invoice.invoice_number} is no longer a claimed draft; the email left, the claim was not settled`);
    }
    await logAdminAction(requireCtx().userId, 'invoice.send', 'invoice', invoice.id,
      { recipient: invoice.billing_email, invoice_number: invoice.invoice_number, message_id: messageId }, ip);
  });
  log.info('finaliseInvoiceSent', { invoiceId: invoice.id }, 'InvoiceSendService');
}

/** Step 3, nothing left (refused by the mail server, or never prepared): the claim is released for a retry. */
export async function releaseInvoiceClaim(invoice: InvoiceForSend, ip: string | null, error: string): Promise<void> {
  await withOwnPlatformAdminTx(async () => {
    await sql`UPDATE admin_invoices SET send_claimed_at = NULL WHERE id = ${invoice.id}::uuid AND status = 'draft'`;
    await logAdminAction(requireCtx().userId, 'invoice.send_failed', 'invoice', invoice.id,
      { recipient: invoice.billing_email, invoice_number: invoice.invoice_number, error }, ip);
  });
}

/** The email may have left: the claim stays; the audit row says so. */
export async function recordSendUnknown(invoice: InvoiceForSend, ip: string | null, error: string): Promise<void> {
  await withOwnPlatformAdminTx(() => logAdminAction(requireCtx().userId, 'invoice.send_unknown', 'invoice', invoice.id,
    { recipient: invoice.billing_email, invoice_number: invoice.invoice_number, error }, ip));
}

export type SettleOutcome = 'sent' | 'released';
export type SettleResult =
  | { ok: true; invoice_number: string }
  | { ok: false; reason: 'not_found' | 'not_claimed' | 'too_fresh' };

/**
 * An admin settles a claim whose outcome was unknown, after reading the email log: 'sent' marks the draft sent,
 * 'released' clears the claim so it can be sent again. Runs in the request transaction (no outside effect).
 * Only a claim older than SEND_SETTLE_AFTER_MS: a younger one may still be a Send talking to the mail server.
 * The UPDATE's own predicate decides, so of two concurrent Settles the second re-reads the row after the first
 * commits, finds no claim, and is refused.
 */
export async function settleInvoiceSend(invoiceId: string, outcome: SettleOutcome, actorId: string, ip: string | null): Promise<SettleResult> {
  const settleAfterSecs = SEND_SETTLE_AFTER_MS / 1000;
  const rows = (outcome === 'sent'
    ? await sql`UPDATE admin_invoices SET status = 'sent', send_claimed_at = NULL
                WHERE id = ${invoiceId}::uuid AND status = 'draft'
                  AND send_claimed_at < NOW() - make_interval(secs => ${settleAfterSecs})
                RETURNING invoice_number`
    : await sql`UPDATE admin_invoices SET send_claimed_at = NULL
                WHERE id = ${invoiceId}::uuid AND status = 'draft'
                  AND send_claimed_at < NOW() - make_interval(secs => ${settleAfterSecs})
                RETURNING invoice_number`) as DbRow[];
  if (rows.length === 0) {
    const current = (await sql`
      SELECT status, send_claimed_at IS NOT NULL AS claimed
      FROM admin_invoices WHERE id = ${invoiceId}::uuid
    `) as DbRow[];
    const r = current[0];
    if (!r) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: r.status === 'draft' && r.claimed === true ? 'too_fresh' : 'not_claimed' };
  }
  const invoiceNumber = String(rows[0]!.invoice_number);
  await logAdminAction(actorId, 'invoice.send_settled', 'invoice', invoiceId, { outcome, invoice_number: invoiceNumber }, ip);
  return { ok: true, invoice_number: invoiceNumber };
}
