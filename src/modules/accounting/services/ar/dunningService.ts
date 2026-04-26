/**
 * PRD-06 Phase 5 — Dunning core: render + send.
 *
 * Rendering applies {{token}} substitution to a template for a given invoice.
 * Sending inserts an immutable dunning_sends row (rendered_subject/body
 * snapshot) + dispatches the email. Template edits after send never rewrite
 * history.
 *
 * Admin/CRUD operations (templates, sends listing, response recording,
 * settings) live in dunningAdmin.ts to keep this file focused.
 *
 * Company-scoped. Never leaks data across tenants.
 */

import crypto from 'node:crypto';

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { sendEmail } from '../core/emailService';
import { BRAND, emailLayout } from '@/lib/email-templates';

export type DunningTone = 'polite' | 'firm' | 'final' | 'legal';
export type TriggerSource = 'manual' | 'cron' | 'auto';
export type ResponseAction = 'paid' | 'promised' | 'disputed' | 'silent';

export interface DunningTemplate {
  id: string;
  name: string;
  tone: DunningTone;
  escalation_order: number;
  days_overdue_min: number;
  days_overdue_max: number | null;
  subject_template: string;
  body_template: string;
  send_weekdays_only: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DunningSendRow {
  id: string;
  company_id: string;
  customer_invoice_id: string;
  template_id: string;
  template_name: string;
  template_tone: DunningTone;
  invoice_number: string;
  customer_name: string;
  sent_at: string;
  sent_to_email: string;
  rendered_subject: string;
  rendered_body: string;
  trigger_source: TriggerSource;
  email_status: 'sent' | 'failed' | 'pending';
  email_error: string | null;
  response_received_at: string | null;
  response_action: ResponseAction | null;
  response_note: string | null;
  message_token: string;
}

export interface RenderedTemplate {
  subject: string;
  body: string;
  to_email: string | null;
  customer_name: string;
  invoice_number: string;
  amount_outstanding: number;
  days_overdue: number;
}

export interface SendResult {
  sendId: string;
  messageToken: string;
  emailStatus: 'sent' | 'failed';
  emailError: string | null;
}

export interface CreateTemplateInput {
  name: string;
  tone: DunningTone;
  escalation_order: number;
  days_overdue_min: number;
  days_overdue_max: number | null;
  subject_template: string;
  body_template: string;
  send_weekdays_only?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export const fmtZar = (n: number): string =>
  `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const toISODate = (d: unknown): string => {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().split('T')[0] ?? '';
  const s = String(d);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? (s.split('T')[0] ?? '') : s;
};

const daysBetween = (a: Date, b: Date): number =>
  Math.floor((a.getTime() - b.getTime()) / 86_400_000);

function applyTokens(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] ?? '' : match,
  );
}

export interface InvoiceCtx {
  invoice_id: string;
  invoice_number: string;
  invoice_date: Date | string;
  due_date: Date | string | null;
  total_amount: string | number;
  amount_paid: string | number;
  outstanding: number;
  days_overdue: number;
  status: string;
  customer_name: string;
  customer_email: string | null;
  company_name: string;
}

export async function loadInvoiceCtx(
  companyId: string,
  invoiceId: string,
): Promise<InvoiceCtx | null> {
  const rows = (await sql`
    SELECT ci.id AS invoice_id, ci.invoice_number, ci.invoice_date, ci.due_date,
           ci.total_amount, ci.amount_paid, ci.status,
           c.name AS customer_name, c.email AS customer_email,
           co.name AS company_name
    FROM customer_invoices ci
    JOIN customers c
      ON c.id = COALESCE(ci.client_id, ci.customer_id)
     AND c.company_id = ci.company_id
    JOIN companies co ON co.id = ci.company_id
    WHERE ci.id = ${invoiceId}::uuid
      AND ci.company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) return null;
  const r = rows[0]!;
  const total = Number(r.total_amount ?? 0);
  const paid = Number(r.amount_paid ?? 0);
  const outstanding = Math.max(0, total - paid);
  const dueStr = toISODate(r.due_date);
  const daysOverdue = dueStr
    ? Math.max(0, daysBetween(new Date(), new Date(dueStr)))
    : 0;
  return {
    invoice_id: String(r.invoice_id),
    invoice_number: String(r.invoice_number ?? ''),
    invoice_date: r.invoice_date as Date | string,
    due_date: r.due_date as Date | string | null,
    total_amount: r.total_amount as string | number,
    amount_paid: r.amount_paid as string | number,
    outstanding,
    days_overdue: daysOverdue,
    status: String(r.status ?? ''),
    customer_name: String(r.customer_name ?? ''),
    customer_email: r.customer_email ? String(r.customer_email) : null,
    company_name: String(r.company_name ?? ''),
  };
}

export async function getTemplateById(
  companyId: string,
  templateId: string,
): Promise<DunningTemplate | null> {
  const rows = (await sql`
    SELECT id, name, tone, escalation_order, days_overdue_min, days_overdue_max,
           subject_template, body_template, send_weekdays_only, active,
           created_at, updated_at
    FROM dunning_templates
    WHERE id = ${templateId}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];
  return (rows[0] as unknown as DunningTemplate) ?? null;
}

// ─── Render ─────────────────────────────────────────────────────────────────

/**
 * Render a template for a specific invoice. Returns null when the invoice
 * is missing; throws when the template doesn't belong to this company.
 */
export async function renderTemplate(
  companyId: string,
  templateId: string,
  invoiceId: string,
  portalBaseUrl?: string,
): Promise<RenderedTemplate | null> {
  const [tmpl, ctx] = await Promise.all([
    getTemplateById(companyId, templateId),
    loadInvoiceCtx(companyId, invoiceId),
  ]);
  if (!tmpl) throw new Error(`Template ${templateId} not found for company`);
  if (!ctx) return null;

  const portalLink = portalBaseUrl
    ? `${portalBaseUrl}/portal/invoice/${ctx.invoice_id}`
    : '(portal link unavailable)';

  const tokens: Record<string, string> = {
    customer_name: ctx.customer_name,
    invoice_number: ctx.invoice_number,
    invoice_date: toISODate(ctx.invoice_date),
    due_date: toISODate(ctx.due_date) || '(no due date)',
    days_overdue: String(ctx.days_overdue),
    amount_outstanding: fmtZar(ctx.outstanding),
    company_name: ctx.company_name,
    portal_link: portalLink,
    reference_note: `[ref: invoice ${ctx.invoice_number}]`,
  };

  return {
    subject: applyTokens(tmpl.subject_template, tokens),
    body: applyTokens(tmpl.body_template, tokens),
    to_email: ctx.customer_email,
    customer_name: ctx.customer_name,
    invoice_number: ctx.invoice_number,
    amount_outstanding: ctx.outstanding,
    days_overdue: ctx.days_overdue,
  };
}

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
