/**
 * Recurring Transaction Service — WS-8.4
 * CRUD + execute for recurring journal/invoice templates.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { RecurringTemplateNotDueError, RecurringTemplateNotFoundError } from './recurringTransactionErrors';
import { lockRecurringTransactionTemplate } from './recurringTemplateLock';
import { newManualJournalGate, settleUnattendedJournal } from '../gl/manualJournalApproval';
import { templateAuthors } from '../gl/manualJournalAuthors';
import {
  mintRecurringCustomerInvoice,
  mintRecurringSupplierInvoice,
} from './recurringTransactionInvoices';
import type { JournalLineInput } from '../../types/gl.types';


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

function mapRow(row: DbRow): RecurringTemplate {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name),
    entityType: String(row.entity_type) as RecurringTemplate['entityType'],
    templateData: (row.template_data !== null && typeof row.template_data === 'object' ? row.template_data : JSON.parse(typeof row.template_data === 'string' ? row.template_data : '{}')) as Record<string, unknown>,
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
  `) as DbRow[];
  return rows.map(mapRow);
}

export async function createRecurringTemplate(
  companyId: string,
  userId: string,
  input: TemplateInput,
): Promise<RecurringTemplate> {
  const rows = (await sql`
    INSERT INTO recurring_transaction_templates
      (company_id, name, entity_type, template_data, frequency, next_run_date, is_active, auto_post, created_by,
       content_authors)
    VALUES (
      ${companyId}, ${input.name}, ${input.entityType},
      ${JSON.stringify(input.templateData)}::JSONB,
      ${input.frequency}, ${input.nextRunDate ?? null},
      ${input.isActive ?? true}, ${input.autoPost ?? false}, ${userId}, ARRAY[${userId}::UUID]
    )
    RETURNING *
  `) as DbRow[];
  log.info('Recurring template created', { id: rows[0]?.id }, 'recurring');
  return mapRow(rows[0]!);
}

export async function updateRecurringTemplate(
  companyId: string,
  id: string,
  updates: Partial<TemplateInput>,
  /**
   * R-035 PR4 review F1: an author of what the template bills when the edit
   * changes it. R-035 PR6 round 3: for a journal template a NAME change counts
   * too — the name is its journals' description when its data carries none.
   */
  editedBy: string,
): Promise<RecurringTemplate> {
  const data = updates.templateData ? JSON.stringify(updates.templateData) : null;
  const rows = (await sql`
    UPDATE recurring_transaction_templates SET
      content_authors = CASE WHEN (${data}::JSONB IS NOT NULL AND template_data IS DISTINCT FROM ${data}::JSONB)
          OR (entity_type = 'journal_entry' AND ${updates.name ?? null}::TEXT IS NOT NULL
              AND name IS DISTINCT FROM ${updates.name ?? null}::TEXT)
        THEN approval_add_author(content_authors, ${editedBy}::UUID) ELSE content_authors END,
      name          = COALESCE(${updates.name ?? null}, name),
      frequency     = COALESCE(${updates.frequency ?? null}, frequency),
      next_run_date = COALESCE(${updates.nextRunDate ?? null}::DATE, next_run_date),
      is_active     = COALESCE(${updates.isActive ?? null}, is_active),
      auto_post     = COALESCE(${updates.autoPost ?? null}, auto_post),
      template_data = COALESCE(${data}::JSONB, template_data)
    WHERE id = ${id}::UUID AND company_id = ${companyId}
    RETURNING *
  `) as DbRow[];
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
): Promise<{ entityType: string; entityId: string; posted: boolean; heldForApproval: string[]; warnings?: string[] }> {
  const row = await lockRecurringTransactionTemplate(companyId, templateId);
  if (!row) throw new RecurringTemplateNotFoundError(templateId);
  // THE SCHEDULE IS THE IDEMPOTENCY KEY. Without this check `executeRecurring`
  // ran whenever it was called: it advanced next_run_date at the end but never
  // read it at the start. What used to stop a repeat run was the month-constant
  // RINV-<slug>-<YYYYMM> number colliding on uq_customer_invoices_company_number
  // — an accident, and one that also broke genuine daily templates. Numbers now
  // come from the company sequence, so a double-click, a client retry or a
  // re-POST would otherwise mint a SECOND real invoice or bill, silently. The
  // row lock above is what makes the check-then-act safe: a concurrent run
  // blocks here, then re-reads the advanced date and is refused.
  if (!row.is_due) {
    throw new RecurringTemplateNotDueError(templateId, fmtDate(row.next_run_date));
  }
  const template = mapRow(row);

  let entityId: string;
  let posted = false;
  const heldForApproval: string[] = [];
  let warnings: string[] = [];

  if (template.entityType === 'journal_entry') {
    const { createJournalEntry, postJournalEntry } =
      await import('../gl/journalEntryService');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = template.templateData as any;
    // A template line's costCenterId is a pick: into its CC1 / CC2 slot, before anything is written.
    const { placeCostCentres } = await import('../gl/dimensions/costCentrePick');
    const placed = await placeCostCentres(companyId, (data.lines || []) as JournalLineInput[]);
    const lines = placed.lines;
    warnings = placed.warnings;
    const { assertNewJournalDimensions } = await import('../gl/dimensions/dimensionPolicy');
    await assertNewJournalDimensions(companyId, 'auto_recurring', lines); // what createJournalEntry would refuse, as a 4xx
    // R-035 PR6: an autoPost run is unattended, so a journal an enforced
    // manual-journal rule governs is held — left a draft, marked, carrying the
    // template's authors, the request raised as the runner — and the schedule
    // below still advances. Decided from reads before the journal is written.
    const approval = await newManualJournalGate(companyId, lines);
    const held = template.autoPost && approval.held;
    const je = await createJournalEntry(companyId, {
      entryDate: new Date().toISOString().split('T')[0]!,
      description: data.description || template.name,
      source: 'auto_recurring',
      lines,
    }, userId);
    entityId = je.id;
    await settleUnattendedJournal(companyId, je.id, userId, { enforced: approval.enforced, held },
      await templateAuthors(companyId, { kind: 'recurring_transaction_template', id: template.id }));
    if (held) heldForApproval.push(je.id);
    else if (template.autoPost) {
      await postJournalEntry(companyId, je.id, userId);
      posted = true;
    }
  } else if (template.entityType === 'customer_invoice') {
    ({ entityId, posted } = await mintRecurringCustomerInvoice(companyId, template, userId));
  } else {
    ({ entityId, posted } = await mintRecurringSupplierInvoice(companyId, template, userId));
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
  return { entityType: template.entityType, entityId, posted, heldForApproval, ...(warnings.length > 0 ? { warnings } : {}) };
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
  `) as DbRow[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    entityType: String(r.entity_type),
    nextRunDate: String(r.next_run_date),
    frequency: String(r.frequency),
  }));
}
