/**
 * PRD-06 Phase 5 — Dunning admin/CRUD: templates, sends query, response
 * recording, and per-company settings. Core render/send lives in
 * dunningService.ts; this file is about managing the surrounding data.
 *
 * Company-scoped. Never leaks data across tenants.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { SA_DEFAULT_TEMPLATES } from './dunningDefaults';
import type {
  DunningTemplate,
  DunningSendRow,
  CreateTemplateInput,
  ResponseAction,
} from './dunningService';

// ─── Template CRUD ─────────────────────────────────────────────────────────

/**
 * Returns the company's dunning templates. Seeds the four SA defaults on
 * first call so a brand-new tenant sees a ready-to-edit ladder.
 */
export async function listTemplates(companyId: string): Promise<DunningTemplate[]> {
  const rows = (await sql`
    SELECT id, name, tone, escalation_order, days_overdue_min, days_overdue_max,
           subject_template, body_template, send_weekdays_only, active,
           created_at, updated_at
    FROM dunning_templates
    WHERE company_id = ${companyId}::uuid
    ORDER BY escalation_order ASC, created_at ASC
  `) as DbRow[];

  if (rows.length > 0) return rows as unknown as DunningTemplate[];

  await seedDefaultTemplates(companyId);

  const seeded = (await sql`
    SELECT id, name, tone, escalation_order, days_overdue_min, days_overdue_max,
           subject_template, body_template, send_weekdays_only, active,
           created_at, updated_at
    FROM dunning_templates
    WHERE company_id = ${companyId}::uuid
    ORDER BY escalation_order ASC
  `) as DbRow[];
  return seeded as unknown as DunningTemplate[];
}

export async function seedDefaultTemplates(companyId: string): Promise<void> {
  for (const t of SA_DEFAULT_TEMPLATES) {
    await sql`
      INSERT INTO dunning_templates (
        company_id, name, tone, escalation_order,
        days_overdue_min, days_overdue_max,
        subject_template, body_template, send_weekdays_only, active
      ) VALUES (
        ${companyId}::uuid, ${t.name}, ${t.tone}, ${t.escalation_order},
        ${t.days_overdue_min}, ${t.days_overdue_max},
        ${t.subject_template}, ${t.body_template}, true, true
      )
      ON CONFLICT (company_id, name) DO NOTHING
    `;
  }
  log.info('Seeded SA default dunning templates', { companyId }, 'dunningAdmin');
}

export async function createTemplate(
  companyId: string,
  input: CreateTemplateInput,
): Promise<DunningTemplate> {
  if (input.days_overdue_min < 0) throw new Error('days_overdue_min must be ≥ 0');
  if (input.days_overdue_max !== null && input.days_overdue_max < input.days_overdue_min) {
    throw new Error('days_overdue_max must be ≥ days_overdue_min');
  }

  const rows = (await sql`
    INSERT INTO dunning_templates (
      company_id, name, tone, escalation_order,
      days_overdue_min, days_overdue_max,
      subject_template, body_template, send_weekdays_only
    ) VALUES (
      ${companyId}::uuid, ${input.name}, ${input.tone}, ${input.escalation_order},
      ${input.days_overdue_min}, ${input.days_overdue_max},
      ${input.subject_template}, ${input.body_template},
      ${input.send_weekdays_only ?? true}
    )
    RETURNING id, name, tone, escalation_order, days_overdue_min, days_overdue_max,
              subject_template, body_template, send_weekdays_only, active,
              created_at, updated_at
  `) as DbRow[];
  return rows[0] as unknown as DunningTemplate;
}

export interface UpdateTemplateInput {
  name?: string;
  tone?: CreateTemplateInput['tone'];
  escalation_order?: number;
  days_overdue_min?: number;
  days_overdue_max?: number | null;
  subject_template?: string;
  body_template?: string;
  send_weekdays_only?: boolean;
  active?: boolean;
}

/**
 * Partial update of a template. Only mutates the fields present in `input`.
 * Returns null when the template doesn't belong to this company.
 */
export async function updateTemplate(
  companyId: string,
  templateId: string,
  input: UpdateTemplateInput,
): Promise<DunningTemplate | null> {
  if (
    input.days_overdue_min !== undefined && input.days_overdue_min < 0
  ) throw new Error('days_overdue_min must be ≥ 0');
  if (
    input.days_overdue_max != null &&
    input.days_overdue_min !== undefined &&
    input.days_overdue_max < input.days_overdue_min
  ) throw new Error('days_overdue_max must be ≥ days_overdue_min');

  const rows = (await sql`
    UPDATE dunning_templates SET
      name               = COALESCE(${input.name ?? null},               name),
      tone               = COALESCE(${input.tone ?? null},               tone),
      escalation_order   = COALESCE(${input.escalation_order ?? null},   escalation_order),
      days_overdue_min   = COALESCE(${input.days_overdue_min ?? null},   days_overdue_min),
      days_overdue_max   = CASE
                             WHEN ${input.days_overdue_max !== undefined}::boolean
                             THEN ${input.days_overdue_max ?? null}::int
                             ELSE days_overdue_max
                           END,
      subject_template   = COALESCE(${input.subject_template ?? null},   subject_template),
      body_template      = COALESCE(${input.body_template ?? null},      body_template),
      send_weekdays_only = COALESCE(${input.send_weekdays_only ?? null}, send_weekdays_only),
      active             = COALESCE(${input.active ?? null},             active),
      updated_at         = NOW()
    WHERE id = ${templateId}::uuid AND company_id = ${companyId}::uuid
    RETURNING id, name, tone, escalation_order, days_overdue_min, days_overdue_max,
              subject_template, body_template, send_weekdays_only, active,
              created_at, updated_at
  `) as DbRow[];
  return (rows[0] as unknown as DunningTemplate) ?? null;
}

/** Soft-delete: marks inactive so the cron walker skips it but audit rows remain intact. */
export async function deactivateTemplate(
  companyId: string,
  templateId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE dunning_templates
    SET active = false, updated_at = NOW()
    WHERE id = ${templateId}::uuid AND company_id = ${companyId}::uuid
    RETURNING id
  `) as DbRow[];
  return rows.length > 0;
}

// ─── Sends query + response ────────────────────────────────────────────────

export interface ListSendsFilters {
  customerInvoiceId?: string;
  responseAction?: ResponseAction | 'none';
  limit?: number;
}

export async function listSends(
  companyId: string,
  filters: ListSendsFilters = {},
): Promise<DunningSendRow[]> {
  const limit = Math.min(filters.limit ?? 100, 500);
  const rows = (await sql`
    SELECT ds.id, ds.company_id, ds.customer_invoice_id, ds.template_id,
           dt.name AS template_name, dt.tone AS template_tone,
           ci.invoice_number,
           c.name AS customer_name,
           ds.sent_at, ds.sent_to_email,
           ds.rendered_subject, ds.rendered_body,
           ds.trigger_source, ds.email_status, ds.email_error,
           ds.response_received_at, ds.response_action, ds.response_note,
           ds.message_token
    FROM dunning_sends ds
    JOIN dunning_templates dt ON dt.id = ds.template_id
    JOIN customer_invoices ci ON ci.id = ds.customer_invoice_id
    JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
    WHERE ds.company_id = ${companyId}::uuid
      AND (${filters.customerInvoiceId ?? null}::uuid IS NULL
           OR ds.customer_invoice_id = ${filters.customerInvoiceId ?? null}::uuid)
      AND (${filters.responseAction ?? null}::text IS NULL
           OR (${filters.responseAction ?? null}::text = 'none'
                 AND ds.response_action IS NULL)
           OR ds.response_action = ${filters.responseAction ?? null}::text)
    ORDER BY ds.sent_at DESC
    LIMIT ${limit}
  `) as DbRow[];
  return rows as unknown as DunningSendRow[];
}

export async function getLatestSendForInvoice(
  companyId: string,
  invoiceId: string,
): Promise<DunningSendRow | null> {
  const rows = await listSends(companyId, { customerInvoiceId: invoiceId, limit: 1 });
  return rows[0] ?? null;
}

export async function recordResponse(
  messageToken: string,
  action: ResponseAction,
  note: string | null,
): Promise<{ updated: boolean; sendId: string | null; companyId: string | null }> {
  const rows = (await sql`
    UPDATE dunning_sends
    SET response_action = ${action},
        response_received_at = NOW(),
        response_note = ${note}
    WHERE message_token = ${messageToken}::uuid
      AND response_action IS NULL
    RETURNING id, company_id
  `) as DbRow[];
  if (rows.length === 0) return { updated: false, sendId: null, companyId: null };
  return {
    updated: true,
    sendId: String(rows[0]!.id),
    companyId: String(rows[0]!.company_id),
  };
}

// ─── Company settings ──────────────────────────────────────────────────────

export interface DunningSettings {
  company_id: string;
  auto_send_enabled: boolean;
  min_outstanding_zar: number;
}

export async function getSettings(companyId: string): Promise<DunningSettings> {
  const rows = (await sql`
    SELECT company_id, auto_send_enabled, min_outstanding_zar
    FROM dunning_settings
    WHERE company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];
  if (rows.length > 0) {
    const r = rows[0]!;
    return {
      company_id: String(r.company_id),
      auto_send_enabled: Boolean(r.auto_send_enabled),
      min_outstanding_zar: Number(r.min_outstanding_zar ?? 0),
    };
  }
  return { company_id: companyId, auto_send_enabled: false, min_outstanding_zar: 0 };
}

export async function updateSettings(
  companyId: string,
  input: Partial<Omit<DunningSettings, 'company_id'>>,
): Promise<DunningSettings> {
  const current = await getSettings(companyId);
  const next = { ...current, ...input };
  await sql`
    INSERT INTO dunning_settings (company_id, auto_send_enabled, min_outstanding_zar, updated_at)
    VALUES (${companyId}::uuid, ${next.auto_send_enabled}, ${next.min_outstanding_zar}, NOW())
    ON CONFLICT (company_id) DO UPDATE
      SET auto_send_enabled    = EXCLUDED.auto_send_enabled,
          min_outstanding_zar  = EXCLUDED.min_outstanding_zar,
          updated_at           = NOW()
  `;
  return next;
}
