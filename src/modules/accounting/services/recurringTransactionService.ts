/**
 * Recurring Transaction Service — WS-8.4
 * CRUD + execute for recurring journal/invoice templates.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export interface RecurringTemplate {
  id: string;
  companyId: string;
  name: string;
  entityType: 'journal_entry' | 'customer_invoice' | 'supplier_invoice';
  templateData: Record<string, unknown>;
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';
  nextRunDate: string | null;
  lastRunDate: string | null;
  isActive: boolean;
  autoPost: boolean;
  createdBy: string;
  createdAt: string;
}

export interface TemplateInput {
  name: string;
  entityType: 'journal_entry' | 'customer_invoice' | 'supplier_invoice';
  templateData: Record<string, unknown>;
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';
  nextRunDate?: string | null;
  isActive?: boolean;
  autoPost?: boolean;
}

export interface UpcomingItem {
  id: string;
  name: string;
  entityType: string;
  nextRunDate: string;
  frequency: string;
}

function mapRow(row: Row): RecurringTemplate {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    entityType: String(row.entity_type) as RecurringTemplate['entityType'],
    templateData: typeof row.template_data === 'object' ? row.template_data : JSON.parse(row.template_data || '{}'),
    frequency: String(row.frequency) as RecurringTemplate['frequency'],
    nextRunDate: row.next_run_date ? String(row.next_run_date) : null,
    lastRunDate: row.last_run_date ? String(row.last_run_date) : null,
    isActive: Boolean(row.is_active),
    autoPost: Boolean(row.auto_post),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

export function calculateNextRunDate(currentDate: Date, frequency: string): Date {
  const d = new Date(currentDate);
  switch (frequency) {
    case 'daily':     d.setDate(d.getDate() + 1); break;
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'monthly':   d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annually':  d.setFullYear(d.getFullYear() + 1); break;
  }
  return d;
}

export async function getRecurringTemplates(companyId: string): Promise<RecurringTemplate[]> {
  const rows = (await sql`
    SELECT * FROM recurring_transaction_templates
    WHERE company_id = ${companyId}
    ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapRow);
}

export async function createRecurringTemplate(
  companyId: string,
  userId: string,
  input: TemplateInput,
): Promise<RecurringTemplate> {
  const rows = (await sql`
    INSERT INTO recurring_transaction_templates
      (company_id, name, entity_type, template_data, frequency, next_run_date, is_active, auto_post, created_by)
    VALUES (
      ${companyId}, ${input.name}, ${input.entityType},
      ${JSON.stringify(input.templateData)}::JSONB,
      ${input.frequency}, ${input.nextRunDate ?? null},
      ${input.isActive ?? true}, ${input.autoPost ?? false}, ${userId}
    )
    RETURNING *
  `) as Row[];
  log.info('Recurring template created', { id: rows[0]?.id }, 'recurring');
  return mapRow(rows[0]!);
}

export async function updateRecurringTemplate(
  companyId: string,
  id: string,
  updates: Partial<TemplateInput>,
): Promise<RecurringTemplate> {
  const rows = (await sql`
    UPDATE recurring_transaction_templates SET
      name          = COALESCE(${updates.name ?? null}, name),
      frequency     = COALESCE(${updates.frequency ?? null}, frequency),
      next_run_date = COALESCE(${updates.nextRunDate ?? null}::DATE, next_run_date),
      is_active     = COALESCE(${updates.isActive ?? null}, is_active),
      auto_post     = COALESCE(${updates.autoPost ?? null}, auto_post),
      template_data = COALESCE(${updates.templateData ? JSON.stringify(updates.templateData) : null}::JSONB, template_data)
    WHERE id = ${id}::UUID AND company_id = ${companyId}
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('Template not found');
  log.info('Recurring template updated', { id }, 'recurring');
  return mapRow(rows[0]!);
}

export async function deleteRecurringTemplate(companyId: string, id: string): Promise<void> {
  await sql`
    DELETE FROM recurring_transaction_templates WHERE id = ${id}::UUID AND company_id = ${companyId}
  `;
  log.info('Recurring template deleted', { id }, 'recurring');
}

export async function executeRecurring(
  companyId: string,
  templateId: string,
  userId: string,
): Promise<{ entityType: string; entityId: string; posted: boolean }> {
  const rows = (await sql`
    SELECT * FROM recurring_transaction_templates
    WHERE id = ${templateId}::UUID AND company_id = ${companyId} AND is_active = true
  `) as Row[];
  if (!rows[0]) throw new Error('Template not found or inactive');
  const template = mapRow(rows[0]!);

  let entityId: string;
  let posted = false;

  if (template.entityType === 'journal_entry') {
    const { createJournalEntry, postJournalEntry } =
      await import('./journalEntryService');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = template.templateData as any;
    const je = await createJournalEntry(companyId, {
      entryDate: new Date().toISOString().split('T')[0]!,
      description: data.description || template.name,
      source: 'auto_recurring',
      lines: data.lines || [],
    }, userId);
    entityId = je.id;
    if (template.autoPost) {
      await postJournalEntry(companyId, je.id, userId);
      posted = true;
    }
  } else if (template.entityType === 'customer_invoice') {
    // Customer invoice: insert with template_data fields
    const data = template.templateData as Record<string, unknown>;
    const ciRows = (await sql`
      INSERT INTO customer_invoices (company_id, client_id, invoice_date, due_date,
        reference, notes, currency, lines, subtotal, vat_amount, total_amount, status)
      VALUES (
        ${companyId},
        ${String(data.clientId || '')},
        CURRENT_DATE,
        CURRENT_DATE::DATE + INTERVAL '30 days',
        ${String(data.reference || 'AUTO-REC')},
        ${String(data.notes || template.name)},
        ${String(data.currency || 'ZAR')},
        ${JSON.stringify(data.lines || [])}::JSONB,
        ${Number(data.subtotal || 0)},
        ${Number(data.vatAmount || 0)},
        ${Number(data.totalAmount || 0)},
        'draft'
      ) RETURNING id
    `) as Row[];
    entityId = String(ciRows[0]?.id);
    if (template.autoPost) {
      await sql`UPDATE customer_invoices SET status = 'posted' WHERE id = ${entityId}::UUID`;
      posted = true;
    }
  } else {
    // Supplier invoice
    const data = template.templateData as Record<string, unknown>;
    const siRows = (await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_date, due_date,
        reference, description, currency, lines, subtotal, vat_amount, total_amount, status)
      VALUES (
        ${companyId},
        ${String(data.supplierId || '')},
        CURRENT_DATE,
        CURRENT_DATE::DATE + INTERVAL '30 days',
        ${String(data.reference || 'AUTO-REC')},
        ${String(data.description || template.name)},
        ${String(data.currency || 'ZAR')},
        ${JSON.stringify(data.lines || [])}::JSONB,
        ${Number(data.subtotal || 0)},
        ${Number(data.vatAmount || 0)},
        ${Number(data.totalAmount || 0)},
        'draft'
      ) RETURNING id
    `) as Row[];
    entityId = String(siRows[0]?.id);
    if (template.autoPost) {
      await sql`UPDATE supplier_invoices SET status = 'posted' WHERE id = ${entityId}::UUID`;
      posted = true;
    }
  }

  // Advance schedule
  const now = new Date();
  const nextDate = calculateNextRunDate(now, template.frequency).toISOString().split('T')[0]!;
  await sql`
    UPDATE recurring_transaction_templates
    SET last_run_date = CURRENT_DATE, next_run_date = ${nextDate}::DATE
    WHERE id = ${templateId}::UUID AND company_id = ${companyId}
  `;

  log.info('Recurring template executed', { templateId, entityId, entityType: template.entityType }, 'recurring');
  return { entityType: template.entityType, entityId, posted };
}

export async function getUpcomingRecurring(
  companyId: string,
  days = 7,
): Promise<UpcomingItem[]> {
  const rows = (await sql`
    SELECT id, name, entity_type, next_run_date, frequency
    FROM recurring_transaction_templates
    WHERE company_id = ${companyId}
      AND is_active = true
      AND next_run_date <= CURRENT_DATE + ${days} * INTERVAL '1 day'
    ORDER BY next_run_date ASC
  `) as Row[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    entityType: String(r.entity_type),
    nextRunDate: String(r.next_run_date),
    frequency: String(r.frequency),
  }));
}
