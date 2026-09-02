import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { resolveRate } from './practiceStaffRateService';
import {
  mapEntry,
  validateClientCategoryWorkItem,
  createPracticeEntry,
} from './practiceTimeEntryService';
import type { PracticeTimeEntry } from './practiceTimeEntryTypes';
import { getEntryTemplate } from './practiceEntryTemplateService';

export interface BulkFromTemplateInput {
  templateId: string;
  dateFrom: string;            // 'YYYY-MM-DD'
  dateTo: string;              // 'YYYY-MM-DD', inclusive
  weekdays?: number[];         // 0=Sun..6=Sat; default [1,2,3,4,5] (Mon-Fri)
  hoursOverride?: number;      // falls back to template.default_hours
  taskOverride?: string;       // falls back to template.task_description
}

export interface BulkFromTemplateResult {
  created: number;
  skipped: number;             // weekend days filtered out
  failed: Array<{ date: string; error: string }>;
}

export async function bulkCreateFromTemplate(
  companyId: string,
  userId: string,
  input: BulkFromTemplateInput,
): Promise<BulkFromTemplateResult> {
  const template = await getEntryTemplate(companyId, input.templateId);
  if (!template) throw new Error('template not found');

  if (!template.practiceClientId || !template.jobCategoryId || !template.workItemId) {
    throw new Error('template is incomplete — client, category and work item required before bulk use');
  }

  const hours = input.hoursOverride ?? template.defaultHours;
  if (hours == null) {
    throw new Error('hours required (template has no default_hours and no hoursOverride)');
  }

  const taskDescription = input.taskOverride ?? template.taskDescription ?? template.name;

  if (input.dateFrom > input.dateTo) {
    throw new Error('dateFrom must be on or before dateTo');
  }

  // Build inclusive date list using UTC to avoid DST drift
  const allDates: string[] = [];
  const [fy, fm, fd] = input.dateFrom.split('-').map(Number) as [number, number, number];
  const [ty, tm, tdd] = input.dateTo.split('-').map(Number) as [number, number, number];
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, tdd));
  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const mo = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(cursor.getUTCDate()).padStart(2, '0');
    allDates.push(`${y}-${mo}-${dy}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  if (allDates.length > 62) {
    throw new Error('bulk range too large (max 62 days)');
  }

  const allowedWeekdays = input.weekdays ?? [1, 2, 3, 4, 5];
  const filteredDates = allDates.filter(
    (d) => allowedWeekdays.includes(new Date(d + 'T00:00:00Z').getUTCDay()),
  );
  const skipped = allDates.length - filteredDates.length;

  let created = 0;
  const failed: Array<{ date: string; error: string }> = [];

  for (const entryDate of filteredDates) {
    try {
      await createPracticeEntry(companyId, userId, {
        entryDate,
        hours,
        practiceClientId: template.practiceClientId,
        jobCategoryId: template.jobCategoryId,
        workItemId: template.workItemId,
        taskDescription,
        notes: template.notes ?? undefined,
        billable: template.billable,
        origin: 'recurring',
      });
      created++;
    } catch (err) {
      failed.push({ date: entryDate, error: err instanceof Error ? err.message : String(err) });
    }
  }

  log.info('Bulk created time entries from template', {
    templateId: input.templateId, created, skipped, failed: failed.length,
  }, 'practice');

  return { created, skipped, failed };
}

export async function duplicatePracticeEntry(
  companyId: string,
  id: string,
  newDate: string,
): Promise<PracticeTimeEntry> {
  const today = new Date().toISOString().split('T')[0]!;
  if (newDate > today) throw new Error('entry date cannot be in the future');

  const sourceRows = (await sql`
    SELECT * FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!sourceRows.length) throw new Error('not found');
  const src = sourceRows[0]!;

  await validateClientCategoryWorkItem(
    companyId,
    String(src.practice_client_id),
    String(src.job_category_id),
    String(src.work_item_id),
  );

  const appliedRate = await resolveRate(
    companyId,
    String(src.user_id),
    String(src.practice_client_id),
    newDate,
  );
  const hours = Number(src.hours);
  const lineTotal = appliedRate != null
    ? Math.round(hours * appliedRate * 100) / 100
    : null;

  const rows = (await sql`
    INSERT INTO time_entries (
      company_id, user_id, entry_date, hours,
      practice_client_id, job_category_id, work_item_id,
      task_description, notes, billable,
      applied_rate, line_total, rate, amount,
      origin, status
    ) VALUES (
      ${companyId}::UUID, ${String(src.user_id)}::UUID, ${newDate}::DATE, ${hours},
      ${String(src.practice_client_id)}::UUID, ${String(src.job_category_id)}::UUID, ${String(src.work_item_id)}::UUID,
      ${String(src.task_description)}, ${src.notes ? String(src.notes) : null}, ${Boolean(src.billable)},
      ${appliedRate}, ${lineTotal}, ${appliedRate}, ${lineTotal},
      'recurring', 'draft'
    ) RETURNING *
  `) as DbRow[];
  if (!rows[0]) throw new Error('database returned no row after insert/update');

  log.info('Duplicated practice time entry', { sourceId: id, newId: rows[0].id, newDate }, 'practice');
  return mapEntry(rows[0]);
}

/**
 * `userId` is optional so the existing REST caller keeps its company-wide
 * behaviour, but every NEW caller should pass it. Without it any authenticated
 * user in the company can submit another user's drafts for approval by id —
 * intra-tenant, but still an authorisation gap. The MCP tool passes it.
 */
export async function submitPracticeEntries(
  companyId: string,
  ids: string[],
  userId?: string,
): Promise<number> {
  if (!ids.length) return 0;
  const scopedUserId = userId ?? null;
  const rows = (await sql`
    UPDATE time_entries
    SET status = 'submitted', updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'draft'
      AND (${scopedUserId}::UUID IS NULL OR user_id = ${scopedUserId}::UUID)
    RETURNING id
  `) as DbRow[];
  log.info('Submitted practice time entries', { count: rows.length }, 'practice');
  return rows.length;
}

export async function approvePracticeEntries(
  companyId: string,
  ids: string[],
  approverUserId: string,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = (await sql`
    UPDATE time_entries
    SET status = 'approved',
        approved_by = ${approverUserId}::UUID,
        approved_at = NOW(),
        updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'submitted'
    RETURNING id
  `) as DbRow[];
  log.info('Approved practice time entries', { count: rows.length, approverUserId }, 'practice');
  return rows.length;
}

export async function markEntriesBilled(
  companyId: string,
  ids: string[],
  invoiceId: string,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = (await sql`
    UPDATE time_entries
    SET status = 'billed',
        invoice_id = ${invoiceId}::UUID,
        billed_at = NOW(),
        updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'approved'
      AND billed_at IS NULL
    RETURNING id
  `) as DbRow[];
  log.info('Marked time entries billed', { count: rows.length, invoiceId }, 'practice');
  return rows.length;
}

export async function writeOffEntries(
  companyId: string,
  ids: string[],
  writtenOffBy: string,
  reason: string,
): Promise<number> {
  if (!ids.length) return 0;
  if (!reason.trim()) throw new Error('write-off reason is required');

  const rows = (await sql`
    UPDATE time_entries
    SET status = 'not_billable',
        write_off_reason = ${reason},
        written_off_by = ${writtenOffBy}::UUID,
        written_off_at = NOW(),
        updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status IN ('submitted', 'approved')
    RETURNING id
  `) as DbRow[];
  log.info('Wrote off time entries', { count: rows.length, reason, writtenOffBy }, 'practice');
  return rows.length;
}
