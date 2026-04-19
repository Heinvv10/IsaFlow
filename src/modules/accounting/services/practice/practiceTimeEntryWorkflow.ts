import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { resolveRate } from './practiceStaffRateService';
import {
  mapEntry,
  validateClientCategoryWorkItem,
} from './practiceTimeEntryService';
import type { PracticeTimeEntry } from './practiceTimeEntryTypes';

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

export async function submitPracticeEntries(companyId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = (await sql`
    UPDATE time_entries
    SET status = 'submitted', updated_at = NOW()
    WHERE company_id = ${companyId}::UUID
      AND id = ANY(${ids}::UUID[])
      AND status = 'draft'
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
