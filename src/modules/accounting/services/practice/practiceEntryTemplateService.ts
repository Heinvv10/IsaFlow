import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface EntryTemplate {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  practiceClientId: string | null;
  jobCategoryId: string | null;
  workItemId: string | null;
  defaultHours: number | null;
  taskDescription: string | null;
  notes: string | null;
  billable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EntryTemplateInput {
  name: string;
  practiceClientId?: string | null;
  jobCategoryId?: string | null;
  workItemId?: string | null;
  defaultHours?: number | null;
  taskDescription?: string | null;
  notes?: string | null;
  billable?: boolean;
}

function mapTemplate(r: DbRow): EntryTemplate {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    name: String(r.name),
    practiceClientId: r.practice_client_id ? String(r.practice_client_id) : null,
    jobCategoryId: r.job_category_id ? String(r.job_category_id) : null,
    workItemId: r.work_item_id ? String(r.work_item_id) : null,
    defaultHours: r.default_hours !== null && r.default_hours !== undefined ? Number(r.default_hours) : null,
    taskDescription: r.task_description ? String(r.task_description) : null,
    notes: r.notes ? String(r.notes) : null,
    billable: Boolean(r.billable),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listEntryTemplates(
  companyId: string,
  userId: string,
): Promise<EntryTemplate[]> {
  const rows = (await sql`
    SELECT * FROM practice_entry_templates
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID
    ORDER BY name ASC
  `) as DbRow[];
  return rows.map(mapTemplate);
}

export async function getEntryTemplate(
  companyId: string,
  id: string,
): Promise<EntryTemplate | null> {
  const rows = (await sql`
    SELECT * FROM practice_entry_templates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length ? mapTemplate(rows[0]!) : null;
}

export async function createEntryTemplate(
  companyId: string,
  userId: string,
  input: EntryTemplateInput,
): Promise<EntryTemplate> {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error('template name is required');

  const rows = (await sql`
    INSERT INTO practice_entry_templates (
      company_id, user_id, name,
      practice_client_id, job_category_id, work_item_id,
      default_hours, task_description, notes, billable
    ) VALUES (
      ${companyId}::UUID, ${userId}::UUID, ${trimmedName},
      ${input.practiceClientId ?? null}::UUID,
      ${input.jobCategoryId ?? null}::UUID,
      ${input.workItemId ?? null}::UUID,
      ${input.defaultHours ?? null},
      ${input.taskDescription ?? null},
      ${input.notes ?? null},
      ${input.billable ?? true}
    ) RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Created entry template', { id: rows[0].id, companyId, userId }, 'practice');
  return mapTemplate(rows[0]);
}

export async function updateEntryTemplate(
  companyId: string,
  id: string,
  input: Partial<EntryTemplateInput>,
): Promise<EntryTemplate> {
  const existing = (await sql`
    SELECT id FROM practice_entry_templates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const trimmedName = input.name !== undefined ? input.name.trim() : undefined;
  if (trimmedName !== undefined && !trimmedName) throw new Error('template name is required');

  const rows = (await sql`
    UPDATE practice_entry_templates SET
      name               = COALESCE(${trimmedName ?? null}, name),
      practice_client_id = COALESCE(${input.practiceClientId ?? null}::UUID, practice_client_id),
      job_category_id    = COALESCE(${input.jobCategoryId ?? null}::UUID, job_category_id),
      work_item_id       = COALESCE(${input.workItemId ?? null}::UUID, work_item_id),
      default_hours      = COALESCE(${input.defaultHours ?? null}, default_hours),
      task_description   = COALESCE(${input.taskDescription ?? null}, task_description),
      notes              = COALESCE(${input.notes ?? null}, notes),
      billable           = COALESCE(${input.billable ?? null}, billable),
      updated_at         = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];

  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Updated entry template', { id, companyId }, 'practice');
  return mapTemplate(rows[0]);
}

export async function deleteEntryTemplate(companyId: string, id: string): Promise<void> {
  const rows = (await sql`
    DELETE FROM practice_entry_templates
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as DbRow[];
  if (!rows.length) throw new Error('not found');
  log.info('Deleted entry template', { id, companyId }, 'practice');
}
