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

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '../core/emailService';
import { BRAND, emailLayout } from '@/lib/email-templates';
import {
  loadInvoiceCtx,
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
  /** Allow send even when outstanding ≤ 0 (test-only). */
  skipPaidGuard?: boolean;
}

export async function sendDunning(input: SendDunningInput): Promise<SendResult> {
  const ctx = await loadInvoiceCtx(input.companyId, input.invoiceId);
  if (!ctx) throw new Error(`Invoice ${input.invoiceId} not found for company`);
  if (!input.skipPaidGuard && ctx.outstanding <= 0) {
    throw new Error('Invoice has no outstanding balance — refusing to send dunning');
  }
  if (ctx.status === 'cancelled') {
    throw new Error('Cannot send dunning for a cancelled invoice');
  }
  if (!ctx.customer_email) {
    throw new Error('Customer has no email address on file');
  }

  const rendered = await renderTemplate(
    input.companyId,
    input.templateId,
    input.invoiceId,
    input.portalBaseUrl,
  );
  if (!rendered) throw new Error('Failed to render template');

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

  // Seal a captured_documents row so every dunning send is a first-class
  // evidence row per PRD §4.6. Bytes-only — no storage upload, since the
  // authoritative copy lives in dunning_sends.rendered_{subject,body}.
  const evidenceBytes = Buffer.from(`${rendered.subject}\n\n${bodyWithToken}`, 'utf8');
  const evidenceHash = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
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
  const evidenceDocId = String(evidenceDoc!.id);

  await sql`
    UPDATE dunning_sends
    SET email_status = ${result.success ? 'sent' : 'failed'},
        email_error  = ${result.success ? null : (result.error ?? 'unknown')},
        source_document_id = ${evidenceDocId}::uuid
    WHERE id = ${sendId}::uuid AND company_id = ${input.companyId}::uuid
  `;

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
