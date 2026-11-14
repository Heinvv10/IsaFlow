/**
 * The two ways a person (or an agent) changes a recurring journal template after it is made: its status, and its
 * header (name, frequency, next run date, description). Both are single predicated UPDATEs, so the rule and the write
 * are one statement — a run generating concurrently holds the row lock, and the UPDATE re-checks after it commits.
 *
 * STATUS. Only these moves exist: active → paused (pause), paused → active (resume), active | paused → cancelled
 * (cancel). Completed and cancelled are final: a cancelled template paused and then resumed came back to life and
 * generated again, and a completed one's next run is past its end date. The rule lives HERE, not in each caller, so
 * every path — the page's actions, the MCP tool, anything later — is held to it.
 *
 * NEXT RUN DATE. A template generates at most one run per period of its frequency, and that is enforced where runs
 * are made (recurringJournalPeriods, before every claim) — whatever sequence of edits set the schedule up. The edit
 * refuses early what generation would refuse anyway, so a person learns it while editing, not on the next run: a next
 * run date in a period the template already generated (at the frequency the edit leaves), one on or before the latest
 * run it generated, and one after the end date. A frequency-only edit is not checked here: the run holds the line.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { RecurringStatus } from '../../types/recurringJournal.types';
import {
  RecurringJournalNotFoundError, RecurringJournalRequestError, readTemplateForUpdate,
} from './recurringJournalGuards';
import { generatedRuns, periodGeneratedError, storedSchedule } from './recurringJournalPeriods';

export type RecurringStatusTarget = 'paused' | 'active' | 'cancelled';

/** The statuses each target may be reached from. */
export const RECURRING_STATUS_FROM: Readonly<Record<RecurringStatusTarget, readonly RecurringStatus[]>> = {
  paused: ['active'],
  active: ['paused'],
  cancelled: ['active', 'paused'],
};

/** `changed: false` — the template exists but is not in a status the move is allowed from: nothing was written. */
export type RecurringStatusChange = { changed: true } | { changed: false; current: RecurringStatus };

/**
 * Move a template to `status`, only from a status that move allows (RECURRING_STATUS_FROM) and, when `from` is given,
 * only while it is still that status (the status the caller read). Throws NotFound when there is no such template in
 * this company; never throws for a refused move — the caller says why, from `current`.
 */
export async function updateRecurringJournalStatus(companyId: string,
  id: string,
  status: RecurringStatusTarget,
  from?: RecurringStatus,
): Promise<RecurringStatusChange> {
  const allowed = RECURRING_STATUS_FROM[status].filter((s) => from === undefined || s === from);
  const result = (await sql`
    UPDATE recurring_journals SET status = ${status}, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = ANY(${[...allowed]}::TEXT[])
    RETURNING id`) as DbRow[];
  if (result.length === 0) {
    const rows = (await sql`
      SELECT status FROM recurring_journals WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    if (!rows[0]) throw new RecurringJournalNotFoundError(id);
    return { changed: false, current: String(rows[0].status) as RecurringStatus };
  }
  log.info('Updated recurring journal status', { id, status }, 'accounting');
  return { changed: true };
}

export interface RecurringTemplateEdit {
  templateName?: string;
  frequency?: string;
  nextRunDate?: string;
  description?: string;
}

/**
 * The page's edit of an active or paused template. A blank field keeps its value. R-035 PR6: an edit that changes
 * what the journals carry (name, description, date) or when they fall (frequency) makes `userId` an author of every
 * journal the template mints (refused as their approver); an edit changing nothing stamps nobody.
 *
 * Refuses (RecurringJournalRequestError, nothing written) the next run dates in the header. A template that is not
 * active or paused is left unchanged, as before.
 */
export async function updateRecurringJournalTemplate(
  companyId: string, id: string, userId: string, edit: RecurringTemplateEdit,
): Promise<void> {
  const { templateName, frequency, nextRunDate, description } = edit;
  const next = nextRunDate || null;
  if (next !== null) await assertNextRunDateAllowed(companyId, id, next, frequency || null);
  const updated = (await sql`
    UPDATE recurring_journals SET
      content_authors = CASE
        WHEN (template_name, frequency, next_run_date, description) IS DISTINCT FROM
             (COALESCE(${templateName || null}, template_name), COALESCE(${frequency || null}, frequency),
              COALESCE(${next}::DATE, next_run_date), COALESCE(${description || null}, description))
        THEN approval_add_author(content_authors, ${userId}::UUID) ELSE content_authors END,
      template_name = COALESCE(${templateName || null}, template_name),
      frequency = COALESCE(${frequency || null}, frequency),
      next_run_date = COALESCE(${next}::DATE, next_run_date),
      description = COALESCE(${description || null}, description),
      updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId} AND status IN ('active', 'paused')
    RETURNING id
  `) as DbRow[];
  if (updated.length > 0) log.info('Recurring journal template edited', { id }, 'accounting');
}

/**
 * The next-run-date refusals, under the template's row lock (held to the end of the request, so no run can claim
 * between this read and the UPDATE). A template that is not active or paused is left alone: the UPDATE skips it.
 */
async function assertNextRunDateAllowed(companyId: string, id: string, next: string, frequency: string | null): Promise<void> {
  const row = await readTemplateForUpdate(companyId, id);
  if (!row || !['active', 'paused'].includes(String(row.status))) return;
  const freq = frequency ?? String(row.frequency);
  const runs = await generatedRuns(companyId, id, next, freq, storedSchedule(row));
  if (runs.clash !== null) throw periodGeneratedError(next, freq, runs);
  if (runs.linked && runs.lastGenerated !== null && next <= runs.lastGenerated) {
    throw new RecurringJournalRequestError(
      `This template last generated on ${runs.lastGenerated}: the next run date must be after it (got ${next}).`,
    );
  }
  if (row.end_date && next > String(row.end_date)) {
    throw new RecurringJournalRequestError(
      `The next run date ${next} is after this template's end date (${String(row.end_date)}), so nothing would ever `
      + 'be generated from it. Choose a date on or before the end date.',
    );
  }
}
