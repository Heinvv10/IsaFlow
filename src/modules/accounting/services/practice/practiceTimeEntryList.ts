import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { PracticeTimeEntry, PracticeEntryFilters } from './practiceTimeEntryTypes';
import { mapEntry } from './practiceTimeEntryService';

/** Moved out of practiceTimeEntryService (300-line limit); re-exported from there. */
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
