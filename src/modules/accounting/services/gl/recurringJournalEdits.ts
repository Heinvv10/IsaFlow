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
 * NEXT RUN DATE. A template generates at most one run per frequency period (week, month, quarter, year:
 * `frequencyPeriodUnit` — of the coarser of the stored frequency and the one the edit leaves). A run is claimed by advancing `next_run_date`, and
 * `last_run_date` records the date of the last run generated (the occurrence, set by the claim). So a new next run
 * whose period is not after last_run_date's period would generate that period a second time — moving back onto the
 * run, or merely later within its month (ran 10 Oct, next moved to 20 Oct) — and run_recurring_journals sweeps every
 * template, so the duplicate is not hypothetical. Refused — UNLESS the new date's period is not before the CURRENT
 * next run's period. That exception is what keeps a legacy row correctable: templates last run before the claim
 * recorded the occurrence hold the day of GENERATION in last_run_date (journals carry no template id, so it cannot be
 * backfilled), which can sit in a later period than the run itself — even after next_run_date. A next run that only
 * moves within or after its current period moves away from what was generated, never onto it: the current next run
 * is always in a period after the last run's (every claim and every allowed edit keeps it so). Refusals cite "last
 * generated on <last_run_date>", true under both meanings. A next run after the end date would never generate
 * anything (the run refuses an ended template), so it is refused too.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { RecurringStatus } from '../../types/recurringJournal.types';
import { RecurringJournalNotFoundError, RecurringJournalRequestError } from './recurringJournalGuards';
import { frequencyPeriodLabel, frequencyPeriodUnit } from './recurringSchedule';

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
 * Refuses (RecurringJournalRequestError, nothing written) a next run date in a period already generated (see the
 * header), or after the end date. A template that is not active or paused is left unchanged, as before.
 */
export async function updateRecurringJournalTemplate(
  companyId: string, id: string, userId: string, edit: RecurringTemplateEdit,
): Promise<void> {
  const { templateName, frequency, nextRunDate, description } = edit;
  const next = nextRunDate || null;
  // The period is the COARSER of the stored frequency (the one the runs were generated under) and the one the edit
  // leaves: a monthly template switched to weekly must not add weekly runs to a month it already generated, nor a
  // weekly one switched to monthly add a monthly run to it. Ranked week < month < quarter < year.
  const rank = (f: ReturnType<typeof sql>) => sql`(CASE ${f} WHEN 'weekly' THEN 1 WHEN 'monthly' THEN 2
    WHEN 'quarterly' THEN 3 ELSE 4 END)`;
  const storedRank = rank(sql`frequency`);
  const editedRank = rank(sql`COALESCE(${frequency || null}, frequency)`);
  const periodFrequency = sql`(CASE GREATEST(${storedRank}, ${editedRank})
    WHEN 1 THEN 'weekly' WHEN 2 THEN 'monthly' WHEN 3 THEN 'quarterly' ELSE 'annually' END)`;
  // Its date_trunc unit ('week' is the ISO week, Monday first).
  const unit = sql`(CASE ${periodFrequency} WHEN 'weekly' THEN 'week' WHEN 'monthly' THEN 'month'
    WHEN 'quarterly' THEN 'quarter' ELSE 'year' END)`;
  // The new next run falls in a period already generated: not after last_run_date's, and before the current next
  // run's (the legacy exception, see the header). The exception rests on the current next run being in a later period
  // than the last run's — true in the STORED frequency's periods only, so it does not apply to an edit that coarsens
  // the frequency (weekly to monthly: next week can still be this month). Read from the row as it stands, in the
  // UPDATE and in the refusal.
  const generatedPeriod = sql`(last_run_date IS NOT NULL
    AND date_trunc(${unit}, ${next}::DATE) <= date_trunc(${unit}, last_run_date)
    AND (${editedRank} > ${storedRank} OR date_trunc(${unit}, ${next}::DATE) < date_trunc(${unit}, next_run_date)))`;
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
      AND (${next}::DATE IS NULL OR (NOT ${generatedPeriod} AND (end_date IS NULL OR ${next}::DATE <= end_date)))
    RETURNING id
  `) as DbRow[];
  if (updated.length > 0 || next === null) return;

  const rows = (await sql`
    SELECT status, last_run_date::TEXT AS last_run, end_date::TEXT AS end_date,
           ${periodFrequency} AS period_frequency, ${generatedPeriod} AS generated_period
    FROM recurring_journals
    WHERE id = ${id}::UUID AND company_id = ${companyId}
  `) as DbRow[];
  const row = rows[0];
  if (!row || !['active', 'paused'].includes(String(row.status))) return; // not editable: unchanged, as before
  if (row.generated_period === true) {
    const freq = String(row.period_frequency);
    throw new RecurringJournalRequestError(
      `This template last generated on ${String(row.last_run)}: ${frequencyPeriodLabel(next, freq)} has already been `
      + `generated for this template — choose a date in a later ${frequencyPeriodUnit(freq)} (post a manual journal `
      + 'for a second run).',
    );
  }
  if (row.end_date !== null && next > String(row.end_date)) {
    throw new RecurringJournalRequestError(
      `The next run date ${next} is after this template's end date (${String(row.end_date)}), so nothing would ever `
      + 'be generated from it. Choose a date on or before the end date.',
    );
  }
}
