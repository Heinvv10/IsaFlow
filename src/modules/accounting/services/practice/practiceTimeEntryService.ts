import { sql, withSavepoint } from '@/lib/neon';
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
} from './practiceTimeEntryTypes';
import { roundHours, lineTotalFor, PracticeEntryRefusal } from './practiceTimeEntryTypes';
import { assertJobForPracticeClient, rethrowJobFkAsRefusal } from './practiceClientFence';
import { mapEntry } from './practiceTimeEntryMap';
import { isRealCalendarDate } from '@/lib/validation';

export { listPracticeEntries } from './practiceTimeEntryList';

/** Sequenced: Postgres shadows a re-declared savepoint name. */
let writeSeq = 0;

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
  if (!clientRows.length) throw new PracticeEntryRefusal('practice client not found or not active');

  const catRows = (await sql`
    SELECT id FROM practice_job_categories
    WHERE id = ${jobCategoryId}::UUID
      AND company_id = ${companyId}::UUID
      AND is_active = true
  `) as DbRow[];
  if (!catRows.length) throw new PracticeEntryRefusal('job category not found or not active');

  const wiRows = (await sql`
    SELECT id FROM practice_work_items
    WHERE id = ${workItemId}::UUID
      AND company_id = ${companyId}::UUID
      AND is_active = true
      AND category_id = ${jobCategoryId}::UUID
  `) as DbRow[];
  if (!wiRows.length) {
    throw new PracticeEntryRefusal('work item not found, not active, or does not belong to selected category');
  }
}

export async function createPracticeEntry(
  companyId: string,
  userId: string,
  input: PracticeTimeEntryInput,
): Promise<PracticeTimeEntry> {
  const today = new Date().toISOString().split('T')[0]!;
  // Strict first: the future check compares strings, and '10000-01-05' sorts before '2026-…'.
  assertRealEntryDate(input.entryDate);
  if (input.entryDate > today) throw new PracticeEntryRefusal('entry date cannot be in the future');
  // Range-check the ROUNDED value: 0.004 is > 0 here but 0.00 in the column.
  const hours = roundHours(input.hours);
  if (!(hours > 0 && hours <= 24)) {
    throw new PracticeEntryRefusal('hours must be between 0 and 24');
  }

  await validateClientCategoryWorkItem(
    companyId,
    input.practiceClientId,
    input.jobCategoryId,
    input.workItemId,
  );
  const jobId = await assertJobForPracticeClient(companyId, input.practiceClientId, input.jobId, { newLink: true });

  const appliedRate = await resolveRate(companyId, userId, input.practiceClientId, input.entryDate);
  const lineTotal = lineTotalFor(hours, appliedRate);

  const origin = input.origin ?? 'manual';
  const billable = input.billable !== false;

  // Savepointed: a job moved since the fence read reaches 851's FK as a 23503 (see rethrowJobFkAsRefusal).
  const rows = await withSavepoint(`te_ins_${++writeSeq}`, async () => (await sql`
    INSERT INTO time_entries (
      company_id, user_id, entry_date, hours,
      practice_client_id, job_category_id, work_item_id,
      task_description, notes, billable,
      applied_rate, line_total, rate, amount,
      origin, status, job_id
    ) VALUES (
      ${companyId}::UUID, ${userId}::UUID, ${input.entryDate}::DATE, ${hours},
      ${input.practiceClientId}::UUID, ${input.jobCategoryId}::UUID, ${input.workItemId}::UUID,
      ${input.taskDescription}, ${input.notes ?? null}, ${billable},
      ${appliedRate}, ${lineTotal}, ${appliedRate}, ${lineTotal},
      ${origin}, 'draft', ${jobId}::UUID
    ) RETURNING *
  `) as DbRow[]).catch((err: unknown) => rethrowJobFkAsRefusal(err, jobId));
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
  /** R-035 PR4 round 2: an author of the invoice the entry is billed on, if this edit changes its rate or billable flag. */
  editedBy: string,
): Promise<PracticeTimeEntry> {
  const existing = (await sql`
    SELECT status, practice_client_id, entry_date, user_id, hours, job_category_id, work_item_id, job_id
    FROM time_entries
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!existing.length) throw new Error('not found');
  if (existing[0]!.status !== 'draft') throw new Error('only draft entries can be updated');

  const row = existing[0]!;

  // Validate entryDate if provided (null, like undefined, leaves it unchanged — the UPDATE COALESCEs it)
  if (input.entryDate != null) {
    assertRealEntryDate(input.entryDate);
    const today = new Date().toISOString().split('T')[0]!;
    if (input.entryDate > today) throw new PracticeEntryRefusal('entry date cannot be in the future');
  }

  // Validate hours if provided
  if (input.hours !== undefined) {
    // The ROUNDED value, as createPracticeEntry checks: 0.004 rounds to 0.00 and hit CHECK hours > 0.
    if (!(roundHours(input.hours) > 0 && input.hours <= 24)) {
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

  // The job (absent/undefined = unchanged, null/'' = clear) must be the entry's client's — re-checked when
  // the client moves. Only a CHANGED job is a new link, which a closed job refuses.
  const updateJob = input.jobId !== undefined;
  const keptJob = row.job_id ? String(row.job_id) : null;
  const jobId = updateJob || changingClient
    ? await assertJobForPracticeClient(companyId, clientId, updateJob ? input.jobId : keptJob,
      { newLink: updateJob && !sameJobId(input.jobId, keptJob) })
    : null;

  const appliedRate = await resolveRate(companyId, userId, clientId, entryDate);
  const effectiveHours = roundHours(input.hours ?? Number(row.hours));
  const lineTotal = lineTotalFor(effectiveHours, appliedRate);

  // R-120: store effectiveHours, not raw input — PG rounds 1.005 up, JS down; the line must match.
  // R-035 PR4 round 2: an edit that re-prices the entry (its resolved rate) or flips billable makes the editor an
  // author of the invoice it is billed on; hours are effort and stamp nobody.
  const updateNotes = 'notes' in input;
  const notesValue = input.notes ?? null;

  const rows = await withSavepoint(`te_upd_${++writeSeq}`, async () => (await sql`
    UPDATE time_entries SET
      content_authors    = CASE WHEN applied_rate IS DISTINCT FROM ${appliedRate}::NUMERIC
                                  OR billable IS DISTINCT FROM COALESCE(${input.billable ?? null}::BOOLEAN, billable)
                             THEN approval_add_author(content_authors, ${editedBy}::UUID) ELSE content_authors END,
      entry_date         = COALESCE(${input.entryDate ?? null}::DATE, entry_date),
      hours              = COALESCE(${input.hours !== undefined ? effectiveHours : null}, hours),
      practice_client_id = COALESCE(${input.practiceClientId ?? null}::UUID, practice_client_id),
      job_category_id    = COALESCE(${input.jobCategoryId ?? null}::UUID, job_category_id),
      work_item_id       = COALESCE(${input.workItemId ?? null}::UUID, work_item_id),
      task_description   = COALESCE(${input.taskDescription ?? null}, task_description),
      notes              = CASE WHEN ${updateNotes}::boolean THEN ${notesValue} ELSE notes END,
      billable           = COALESCE(${input.billable ?? null}, billable),
      job_id             = CASE WHEN ${updateJob}::boolean THEN ${jobId}::UUID ELSE job_id END,
      applied_rate       = ${appliedRate},
      line_total         = ${lineTotal},
      rate               = ${appliedRate},
      amount             = ${lineTotal},
      updated_at         = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    RETURNING *
  `) as DbRow[]).catch((err: unknown) => rethrowJobFkAsRefusal(err, jobId ?? keptJob));
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

/** Ids compare case-insensitively (Postgres stores a uuid lowercase): an uppercase copy of the kept job is not a new link. */
function sameJobId(next: unknown, kept: string | null): boolean {
  return typeof next === 'string' && kept !== null && next.toLowerCase() === kept.toLowerCase();
}

function assertRealEntryDate(value: unknown): void {
  if (typeof value !== 'string' || !isRealCalendarDate(value)) {
    throw new PracticeEntryRefusal('entry date must be a real date (YYYY-MM-DD)');
  }
}
