import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { resolveRate } from './practiceStaffRateService';

export type {
  PracticeTimeEntry,
  PracticeTimeEntryInput,
  PracticeTimeEntryUpdateInput,
  PracticeEntryFilters,
} from './practiceTimeEntryTypes';

import type {
  PracticeTimeEntry,
  PracticeTimeEntryInput,
  PracticeTimeEntryUpdateInput,
  PracticeEntryFilters,
} from './practiceTimeEntryTypes';
import { roundHours, lineTotalFor } from './practiceTimeEntryTypes';

/** @internal used by practiceTimeEntryWorkflow — do not import elsewhere */
export function mapEntry(r: DbRow): PracticeTimeEntry {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    userId: String(r.user_id),
    entryDate: fmtDate(r.entry_date),
    hours: Number(r.hours),
    practiceClientId: String(r.practice_client_id),
    jobCategoryId: String(r.job_category_id),
    workItemId: String(r.work_item_id),
    taskDescription: String(r.task_description),
    notes: r.notes ? String(r.notes) : null,
    billable: Boolean(r.billable),
    appliedRate: r.applied_rate != null ? Number(r.applied_rate) : null,
    lineTotal: r.line_total != null ? Number(r.line_total) : null,
    origin: String(r.origin) as PracticeTimeEntry['origin'],
    status: String(r.status) as PracticeTimeEntry['status'],
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    billedAt: r.billed_at ? String(r.billed_at) : null,
    invoiceId: r.invoice_id ? String(r.invoice_id) : null,
    jobId: r.job_id ? String(r.job_id) : null,
    writeOffReason: r.write_off_reason ? String(r.write_off_reason) : null,
    writtenOffBy: r.written_off_by ? String(r.written_off_by) : null,
    writtenOffAt: r.written_off_at ? String(r.written_off_at) : null,
    practiceClientName: r.practice_client_name ? String(r.practice_client_name) : null,
    jobCategoryName: r.job_category_name ? String(r.job_category_name) : null,
    workItemName: r.work_item_name ? String(r.work_item_name) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** @internal used by practiceTimeEntryWorkflow — do not import elsewhere */
export async function validateClientCategoryWorkItem(
  companyId: string,
  practiceClientId: string,
  jobCategoryId: string,
  workItemId: string,
): Promise<void> {
  const clientRows = (await sql`
    SELECT id FROM practice_clients
    WHERE id = ${practiceClientId}::UUID
      AND company_id = ${companyId}::UUID
      AND status = 'active'
  `) as DbRow[];
  if (!clientRows.length) throw new Error('practice client not found or not active');

  const catRows = (await sql`
    SELECT id FROM practice_job_categories
    WHERE id = ${jobCategoryId}::UUID
      AND company_id = ${companyId}::UUID
      AND is_active = true
  `) as DbRow[];
  if (!catRows.length) throw new Error('job category not found or not active');

  const wiRows = (await sql`
    SELECT id FROM practice_work_items
    WHERE id = ${workItemId}::UUID
      AND company_id = ${companyId}::UUID
      AND is_active = true
      AND category_id = ${jobCategoryId}::UUID
  `) as DbRow[];
  if (!wiRows.length) {
    throw new Error('work item not found, not active, or does not belong to selected category');
  }
}

export async function createPracticeEntry(
  companyId: string,
  userId: string,
  input: PracticeTimeEntryInput,
): Promise<PracticeTimeEntry> {
  const today = new Date().toISOString().split('T')[0]!;
  if (input.entryDate > today) throw new Error('entry date cannot be in the future');
  // Range-check the ROUNDED value: 0.004 is > 0 here but 0.00 in the column.
  const hours = roundHours(input.hours);
  if (!(hours > 0 && hours <= 24)) {
    throw new Error('hours must be between 0 and 24');
  }

  await validateClientCategoryWorkItem(
    companyId,
    input.practiceClientId,
    input.jobCategoryId,
    input.workItemId,
  );

  const appliedRate = await resolveRate(companyId, userId, input.practiceClientId, input.entryDate);
  const lineTotal = lineTotalFor(hours, appliedRate);

  const origin = input.origin ?? 'manual';
  const billable = input.billable !== false;

  const rows = (await sql`
    INSERT INTO time_entries (
      company_id, user_id, entry_date, hours,
      practice_client_id, job_category_id, work_item_id,
      task_description, notes, billable,
      applied_rate, line_total, rate, amount,
      origin, status
    ) VALUES (
      ${companyId}::UUID, ${userId}::UUID, ${input.entryDate}::DATE, ${hours},
      ${input.practiceClientId}::UUID, ${input.jobCategoryId}::UUID, ${input.workItemId}::UUID,
      ${input.taskDescription}, ${input.notes ?? null}, ${billable},
      ${appliedRate}, ${lineTotal}, ${appliedRate}, ${lineTotal},
      ${origin}, 'draft'
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');

  log.info('Created practice time entry', {
    id: rows[0].id, userId, clientId: input.practiceClientId, hours: input.hours,
  }, 'practice');
  return mapEntry(rows[0]);
}

export async function updatePracticeEntry(
  companyId: string,
  id: string,
  input: PracticeTimeEntryUpdateInput,
): Promise<PracticeTimeEntry> {
  const existing = (await sql`
    SELECT status, practice_client_id, entry_date, user_id, hours, job_category_id, work_item_id
    FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');
  if (existing[0]!.status !== 'draft') throw new Error('only draft entries can be updated');

  const row = existing[0]!;

  // Validate entryDate if provided
  if (input.entryDate !== undefined) {
    const today = new Date().toISOString().split('T')[0]!;
    if (input.entryDate > today) throw new Error('entry date cannot be in the future');
  }

  // Validate hours if provided
  if (input.hours !== undefined) {
    if (!(input.hours > 0 && input.hours <= 24)) {
      throw new Error('hours must be between 0 and 24');
    }
  }

  // Validate client/category/work-item when any of them are being changed
  const changingClient = input.practiceClientId !== undefined;
  const changingCategory = input.jobCategoryId !== undefined;
  const changingWorkItem = input.workItemId !== undefined;

  if (changingClient || changingCategory || changingWorkItem) {
    const effectiveClientId = String(input.practiceClientId ?? row.practice_client_id);
    const effectiveCategoryId = String(input.jobCategoryId ?? row.job_category_id);
    const effectiveWorkItemId = String(input.workItemId ?? row.work_item_id);
    await validateClientCategoryWorkItem(
      companyId,
      effectiveClientId,
      effectiveCategoryId,
      effectiveWorkItemId,
    );
  }

  const clientId = String(input.practiceClientId ?? row.practice_client_id);
  const entryDate = String(input.entryDate ?? row.entry_date);
  const userId = String(row.user_id);

  const appliedRate = await resolveRate(companyId, userId, clientId, entryDate);
  const effectiveHours = roundHours(input.hours ?? Number(row.hours));
  const lineTotal = lineTotalFor(effectiveHours, appliedRate);

  const updateNotes = 'notes' in input;
  const notesValue = input.notes ?? null;

  const rows = (await sql`
    UPDATE time_entries SET
      entry_date         = COALESCE(${input.entryDate ?? null}::DATE, entry_date),
      hours              = COALESCE(${input.hours ?? null}, hours),
      practice_client_id = COALESCE(${input.practiceClientId ?? null}::UUID, practice_client_id),
      job_category_id    = COALESCE(${input.jobCategoryId ?? null}::UUID, job_category_id),
      work_item_id       = COALESCE(${input.workItemId ?? null}::UUID, work_item_id),
      task_description   = COALESCE(${input.taskDescription ?? null}, task_description),
      notes              = CASE WHEN ${updateNotes}::boolean THEN ${notesValue} ELSE notes END,
      billable           = COALESCE(${input.billable ?? null}, billable),
      applied_rate       = ${appliedRate},
      line_total         = ${lineTotal},
      rate               = ${appliedRate},
      amount             = ${lineTotal},
      updated_at         = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');

  log.info('Updated practice time entry', { id, companyId }, 'practice');
  return mapEntry(rows[0]);
}

export async function deletePracticeEntry(companyId: string, id: string): Promise<void> {
  const existing = (await sql`
    SELECT status FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');
  if (existing[0]!.status !== 'draft') throw new Error('only draft entries can be deleted');

  await sql`
    DELETE FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Deleted practice time entry', { id, companyId }, 'practice');
}

export async function getPracticeEntry(companyId: string, id: string): Promise<PracticeTimeEntry | null> {
  const rows = (await sql`
    SELECT
      te.*,
      pc.legal_name AS practice_client_name,
      pjc.name      AS job_category_name,
      pwi.name      AS work_item_name
    FROM time_entries te
    LEFT JOIN practice_clients        pc  ON pc.id  = te.practice_client_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    LEFT JOIN practice_work_items     pwi ON pwi.id = te.work_item_id
    WHERE te.id = ${id}::UUID AND te.company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length ? mapEntry(rows[0]!) : null;
}

/**
 * Resolve the status of specific entries, scoped to one company and (optionally)
 * one user. O(ids), not O(everything the user has ever logged.)
 *
 * Callers that need to decide whether a supplied set of ids is actionable must
 * use this rather than listing the user's entries and filtering in memory — a
 * staff member with years of history would otherwise pull their entire
 * timesheet into the process on every call.
 */
export async function getEntryStatusesByIds(
  companyId: string,
  ids: string[],
  userId?: string,
): Promise<Map<string, PracticeTimeEntry['status']>> {
  if (!ids.length) return new Map();
  const scopedUserId = userId ?? null;
  const rows = (await sql`
    SELECT id, status FROM time_entries
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND (${scopedUserId}::UUID IS NULL OR user_id = ${scopedUserId}::UUID)
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), String(r.status) as PracticeTimeEntry['status']]));
}

export async function listPracticeEntries(
  companyId: string,
  filters: PracticeEntryFilters = {},
): Promise<{ entries: PracticeTimeEntry[]; total: number }> {
  const userId = filters.userId ?? null;
  const practiceClientId = filters.practiceClientId ?? null;
  const dateFrom = filters.dateFrom ?? null;
  const dateTo = filters.dateTo ?? null;
  const status = filters.status ?? null;
  const jobId = filters.jobId ?? null;
  const limit = filters.limit ?? null;
  const offset = filters.offset ?? null;

  const countRows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM time_entries te
    WHERE te.company_id = ${companyId}::UUID
      AND (${userId}::UUID IS NULL       OR te.user_id            = ${userId}::UUID)
      AND (${practiceClientId}::UUID IS NULL OR te.practice_client_id = ${practiceClientId}::UUID)
      AND (${dateFrom}::DATE IS NULL     OR te.entry_date        >= ${dateFrom}::DATE)
      AND (${dateTo}::DATE IS NULL       OR te.entry_date        <= ${dateTo}::DATE)
      AND (${status}::TEXT IS NULL       OR te.status             = ${status}::TEXT)
      AND (${jobId}::UUID IS NULL        OR te.job_id             = ${jobId}::UUID)
      -- Scope to practice-side entries only; legacy time_entries without a practice_client_id belong to the old project timesheets
      AND te.practice_client_id IS NOT NULL
  `) as DbRow[];

  const rows = (await sql`
    SELECT
      te.*,
      pc.legal_name AS practice_client_name,
      pjc.name      AS job_category_name,
      pwi.name      AS work_item_name
    FROM time_entries te
    LEFT JOIN practice_clients        pc  ON pc.id  = te.practice_client_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    LEFT JOIN practice_work_items     pwi ON pwi.id = te.work_item_id
    WHERE te.company_id = ${companyId}::UUID
      AND (${userId}::UUID IS NULL       OR te.user_id            = ${userId}::UUID)
      AND (${practiceClientId}::UUID IS NULL OR te.practice_client_id = ${practiceClientId}::UUID)
      AND (${dateFrom}::DATE IS NULL     OR te.entry_date        >= ${dateFrom}::DATE)
      AND (${dateTo}::DATE IS NULL       OR te.entry_date        <= ${dateTo}::DATE)
      AND (${status}::TEXT IS NULL       OR te.status             = ${status}::TEXT)
      AND (${jobId}::UUID IS NULL        OR te.job_id             = ${jobId}::UUID)
      -- Scope to practice-side entries only; legacy time_entries without a practice_client_id belong to the old project timesheets
      AND te.practice_client_id IS NOT NULL
    ORDER BY te.entry_date DESC, te.created_at DESC
    LIMIT ${limit}::INT OFFSET ${offset}::INT
  `) as DbRow[];

  return { entries: rows.map(mapEntry), total: Number(countRows[0]?.cnt ?? 0) };
}


