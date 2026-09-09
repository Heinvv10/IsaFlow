/**
 * PRD-06 Phase 5 — Dunning send.
 *
 * Split out of dunningService.ts (300-line limit). Renders the template, then
 * writes the immutable dunning_sends snapshot, dispatches the email and seals
 * a captured_documents evidence row.
 *
 * Company-scoped. Never leaks data across tenants.
 */

import crypto from 'node:crypto';

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '../core/emailService';
import { ArRequestError } from './arErrors';
import { BRAND, emailLayout } from '@/lib/email-templates';
import {
  loadInvoiceCtx,
  PORTAL_LINK_UNAVAILABLE,
  renderTemplate,
  type SendResult,
  type TriggerSource,
} from './dunningService';

// ─── Send ───────────────────────────────────────────────────────────────────

export interface SendDunningInput {
  companyId: string;
  templateId: string;
  invoiceId: string;
  sentBy?: string | null;
  triggerSource?: TriggerSource;
  portalBaseUrl?: string;
  /**
   * Allow send even when outstanding ≤ 0. TEST-ONLY: this disables a financial
   * guard, so it must never become reachable from a request body. It is safe
   * today only because pages/api/accounting/ar/dunning/send.ts parses a
   * `.strict()` Zod body of exactly {invoiceId, templateId} and passes the
   * fields explicitly — one `...parsed.data` spread away from being reachable.
   * Keep it that way.
   */
  skipPaidGuard?: boolean;
}

export async function sendDunning(input: SendDunningInput): Promise<SendResult> {
  const ctx = await loadInvoiceCtx(input.companyId, input.invoiceId);
  if (!ctx) {
    throw new ArRequestError(
      `Invoice ${input.invoiceId} not found for company`, 404, 'DUNNING_INVOICE_NOT_FOUND',
    );
  }
  if (!input.skipPaidGuard && ctx.outstanding <= 0) {
    throw new ArRequestError(
      'Invoice has no outstanding balance — refusing to send dunning',
      400, 'DUNNING_INVOICE_PAID',
    );
  }
  if (ctx.status === 'cancelled') {
    throw new ArRequestError(
      'Cannot send dunning for a cancelled invoice', 400, 'DUNNING_INVOICE_CANCELLED',
    );
  }
  if (!ctx.customer_email) {
    throw new ArRequestError(
      'Customer has no email address on file', 400, 'DUNNING_NO_EMAIL',
    );
  }

  const rendered = await renderTemplate(
    input.companyId,
    input.templateId,
    input.invoiceId,
    input.portalBaseUrl,
  );
  if (!rendered) throw new Error('Failed to render template');
  // renderTemplate falls back to the placeholder when there is no portal base
  // URL configured or the invoice is not portal-eligible. Emailing that text
  // and recording email_status 'sent' is the same failure as the swallowed
  // mint: the customer gets a reminder with no way to pay and the send looks
  // successful. Refuse instead.
  if (rendered.body.includes(PORTAL_LINK_UNAVAILABLE)
      || rendered.subject.includes(PORTAL_LINK_UNAVAILABLE)) {
    throw new ArRequestError(
      'Refusing to send dunning: the portal link could not be resolved',
      400, 'DUNNING_PORTAL_LINK_UNAVAILABLE',
    );
  }

  const insertRows = (await sql`
    INSERT INTO dunning_sends (
      company_id, customer_invoice_id, template_id, sent_to_email,
      rendered_subject, rendered_body, trigger_source, sent_by, email_status
    ) VALUES (
      ${input.companyId}::uuid, ${input.invoiceId}::uuid, ${input.templateId}::uuid,
      ${ctx.customer_email},
      ${rendered.subject}, ${rendered.body},
      ${input.triggerSource ?? 'manual'}, ${input.sentBy ?? null}, 'pending'
    )
    RETURNING id, message_token
  `) as DbRow[];
  const sendRow = insertRows[0]!;
  const sendId = String(sendRow.id);
  const messageToken = String(sendRow.message_token);

  const bodyWithToken = `${rendered.body}\n\n[ref:${messageToken}]`;
  const escapedBody = bodyWithToken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const html = emailLayout(`
    <tr>
      <td style="padding:36px 32px 28px; font-family:${BRAND.fontStack};
                 font-size:15px; color:${BRAND.textBody}; line-height:1.6;">
        ${escapedBody}
      </td>
    </tr>`);

  const result = await sendEmail({
    to: ctx.customer_email,
    subject: rendered.subject,
    html,
    _log: {
      companyId: input.companyId,
      emailType: 'other',
      sentBy: input.sentBy ?? null,
    },
  });

  // The email has left the building. Record its outcome BEFORE anything that
  // can still fail: everything below runs inside the cron's per-invoice
  // savepoint, and a rollback there would erase the dunning_sends row while
  // the customer keeps the email — the cron's "no existing send for this
  // (invoice, template)" gate would then re-send the same escalation tomorrow.
  await sql`
    UPDATE dunning_sends
    SET email_status = ${result.success ? 'sent' : 'failed'},
        email_error  = ${result.success ? null : (result.error ?? 'unknown')}
    WHERE id = ${sendId}::uuid AND company_id = ${input.companyId}::uuid
  `;

  // Seal a captured_documents row so every dunning send is a first-class
  // evidence row per PRD §4.6. Bytes-only — no storage upload, since the
  // authoritative copy lives in dunning_sends.rendered_{subject,body}.
  //
  // Evidence is secondary to the send itself, so its failure is logged, never
  // allowed to unwind the record of an email that was already delivered. Its
  // own savepoint, because a caught PG error would otherwise abort the
  // surrounding transaction and every later statement would raise 25P02.
  const evidenceBytes = Buffer.from(`${rendered.subject}\n\n${bodyWithToken}`, 'utf8');
  const evidenceHash = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
  try {
    await withSavepoint('dunning_send_evidence', async () => {
      const [evidenceDoc] = (await sql`
        INSERT INTO captured_documents (
          company_id, file_name, file_type, file_size,
          document_type, status,
          raw_bytes_sha256, raw_bytes_size,
          notes
        ) VALUES (
          ${input.companyId}::uuid,
          ${`dunning-${messageToken}.txt`},
          'text/plain',
          ${evidenceBytes.length},
          'dunning',
          'matched',
          ${evidenceHash},
          ${evidenceBytes.length},
          ${`Dunning · invoice ${ctx.invoice_number} · to ${ctx.customer_email}`}
        )
        RETURNING id
      `) as DbRow[];
      await sql`
        UPDATE dunning_sends
        SET source_document_id = ${String(evidenceDoc!.id)}::uuid
        WHERE id = ${sendId}::uuid AND company_id = ${input.companyId}::uuid
      `;
    });
  } catch (err) {
    log.warn('Dunning evidence row failed; the send itself stands', {
      sendId,
      invoiceId: input.invoiceId,
      error: err instanceof Error ? err.message : String(err),
    }, 'dunningService');
  }

  log.info('Dunning send', {
    sendId, invoiceId: input.invoiceId, templateId: input.templateId,
    emailStatus: result.success ? 'sent' : 'failed',
  }, 'dunningService');

  return {
    sendId,
    messageToken,
    emailStatus: result.success ? 'sent' : 'failed',
    emailError: result.success ? null : (result.error ?? 'unknown'),
  };
}
