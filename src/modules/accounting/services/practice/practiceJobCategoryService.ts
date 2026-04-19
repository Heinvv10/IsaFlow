import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface JobCategory {
  id: string;
  companyId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  reportingTag: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItem {
  id: string;
  companyId: string;
  categoryId: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  defaultBillable: boolean;
  defaultRateOverride: number | null;
  createdAt: string;
  updatedAt: string;
}

function mapCategory(r: DbRow): JobCategory {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    name: String(r.name),
    sortOrder: Number(r.sort_order),
    isActive: Boolean(r.is_active),
    reportingTag: r.reporting_tag ? String(r.reporting_tag) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapWorkItem(r: DbRow): WorkItem {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    categoryId: String(r.category_id),
    name: String(r.name),
    sortOrder: Number(r.sort_order),
    isActive: Boolean(r.is_active),
    defaultBillable: Boolean(r.default_billable),
    defaultRateOverride: r.default_rate_override != null ? Number(r.default_rate_override) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listJobCategories(companyId: string, includeInactive = false): Promise<JobCategory[]> {
  let rows: DbRow[];
  if (includeInactive) {
    rows = (await sql`
      SELECT * FROM practice_job_categories
      WHERE company_id = ${companyId}::UUID
      ORDER BY sort_order ASC, name ASC
    `) as DbRow[];
  } else {
    rows = (await sql`
      SELECT * FROM practice_job_categories
      WHERE company_id = ${companyId}::UUID AND is_active = true
      ORDER BY sort_order ASC, name ASC
    `) as DbRow[];
  }
  return rows.map(mapCategory);
}

export async function createJobCategory(
  companyId: string,
  input: { name: string; sortOrder?: number; reportingTag?: string },
): Promise<JobCategory> {
  const rows = (await sql`
    INSERT INTO practice_job_categories (company_id, name, sort_order, reporting_tag)
    VALUES (${companyId}::UUID, ${input.name}, ${input.sortOrder ?? 0}, ${input.reportingTag ?? null})
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  log.info('Created job category', { id: rows[0].id }, 'practice');
  return mapCategory(rows[0]);
}

export async function updateJobCategory(
  companyId: string,
  id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean; reportingTag?: string },
): Promise<JobCategory> {
  const existing = (await sql`
    SELECT id FROM practice_job_categories WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_job_categories SET
      name          = COALESCE(${input.name ?? null}, name),
      sort_order    = COALESCE(${input.sortOrder ?? null}, sort_order),
      is_active     = COALESCE(${input.isActive ?? null}, is_active),
      reporting_tag = COALESCE(${input.reportingTag ?? null}, reporting_tag),
      updated_at    = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  return mapCategory(rows[0]);
}

export async function deleteJobCategory(companyId: string, id: string): Promise<void> {
  const existing = (await sql`
    SELECT id FROM practice_job_categories WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  await sql`
    UPDATE practice_job_categories SET is_active = false, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Deactivated job category', { id }, 'practice');
}

export async function listWorkItems(companyId: string, categoryId?: string, includeInactive = false): Promise<WorkItem[]> {
  let rows: DbRow[];
  if (categoryId && includeInactive) {
    rows = (await sql`
      SELECT * FROM practice_work_items
      WHERE company_id = ${companyId}::UUID AND category_id = ${categoryId}::UUID
      ORDER BY sort_order ASC, name ASC
    `) as DbRow[];
  } else if (categoryId) {
    rows = (await sql`
      SELECT * FROM practice_work_items
      WHERE company_id = ${companyId}::UUID AND category_id = ${categoryId}::UUID AND is_active = true
      ORDER BY sort_order ASC, name ASC
    `) as DbRow[];
  } else if (includeInactive) {
    rows = (await sql`
      SELECT * FROM practice_work_items
      WHERE company_id = ${companyId}::UUID
      ORDER BY sort_order ASC, name ASC
    `) as DbRow[];
  } else {
    rows = (await sql`
      SELECT * FROM practice_work_items
      WHERE company_id = ${companyId}::UUID AND is_active = true
      ORDER BY sort_order ASC, name ASC
    `) as DbRow[];
  }
  return rows.map(mapWorkItem);
}

export async function createWorkItem(
  companyId: string,
  categoryId: string,
  input: { name: string; sortOrder?: number; defaultBillable?: boolean; defaultRateOverride?: number },
): Promise<WorkItem> {
  const rows = (await sql`
    INSERT INTO practice_work_items (company_id, category_id, name, sort_order, default_billable, default_rate_override)
    VALUES (
      ${companyId}::UUID, ${categoryId}::UUID, ${input.name},
      ${input.sortOrder ?? 0}, ${input.defaultBillable ?? true},
      ${input.defaultRateOverride ?? null}
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  return mapWorkItem(rows[0]);
}

export async function updateWorkItem(
  companyId: string,
  id: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean; defaultBillable?: boolean; defaultRateOverride?: number },
): Promise<WorkItem> {
  const existing = (await sql`
    SELECT id FROM practice_work_items WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');

  const rows = (await sql`
    UPDATE practice_work_items SET
      name                  = COALESCE(${input.name ?? null}, name),
      sort_order            = COALESCE(${input.sortOrder ?? null}, sort_order),
      is_active             = COALESCE(${input.isActive ?? null}, is_active),
      default_billable      = COALESCE(${input.defaultBillable ?? null}, default_billable),
      default_rate_override = COALESCE(${input.defaultRateOverride ?? null}, default_rate_override),
      updated_at            = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');
  return mapWorkItem(rows[0]);
}

export async function seedDefaultCategories(companyId: string): Promise<void> {
  const count = (await sql`
    SELECT COUNT(*)::int AS cnt FROM practice_job_categories WHERE company_id = ${companyId}::UUID
  `) as DbRow[];
  if (Number(count[0]?.cnt) > 0) return;

  await sql`
    INSERT INTO practice_job_categories (company_id, name, sort_order, reporting_tag)
    SELECT ${companyId}::UUID, name, sort_order, reporting_tag
    FROM practice_default_categories
    ORDER BY sort_order
  `;
  log.info('Seeded default categories', { companyId }, 'practice');
}
