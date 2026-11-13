/**
 * A recurring template generates at most ONE run per period of its frequency (ISO week, calendar month, quarter,
 * year) — enforced where runs are made, not by policing every edit that could set up a second one (breaker 7e
 * round 4: frequency-only edits and chained edits each found a way past the edit rules).
 *
 * THE LINK. Every journal a run generates carries `source_record_id` = the template id (source `auto_recurring`;
 * the column is polymorphic by source, migration 526). A period is GENERATED while a LIVE linked journal is dated in
 * it: draft or posted, not reversed (`reversed_at`), not itself a reversal. Reversing the journal, or deleting the
 * draft, frees its period.
 *
 * LEGACY. Journals generated before the link carry none, so they cannot be found. For a template with NO linked
 * journal at all, the period of `last_run_date` counts as generated — under either of its meanings (the day a legacy
 * run was generated, or a newer run's own date) that period held a run. What stays undetectable: a legacy run in an
 * earlier period than last_run_date's (a template moved back before the link existed). Known limit: a template
 * whose ONLY linked journal was a draft that was then deleted has no link left, so the fallback keeps last_run_date's
 * period blocked — the refusal says to post a manual journal.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { RecurringJournalRequestError } from './recurringJournalGuards';
import { frequencyPeriodLabel, frequencyPeriodUnit } from './recurringSchedule';

/** The run would land in a period this template already generated. UI 400; MCP skip `period_already_generated`. */
export class RecurringJournalPeriodGeneratedError extends RecurringJournalRequestError {
  override readonly code = 'RECURRING_JOURNAL_PERIOD_GENERATED';
  constructor(message: string) {
    super(message);
    this.name = 'RecurringJournalPeriodGeneratedError';
  }
}

export interface GeneratedRuns {
  /** The live linked run dated in `date`'s period — or last_run_date, for a template with no linked journal. */
  clash: string | null;
  /** The latest live linked run; for a template with no linked journal, last_run_date. */
  lastGenerated: string | null;
  /** Whether any journal (live or not) links to the template — false: the legacy fallback applies. */
  linked: boolean;
}

/** What the template has generated, as seen from a run (or a next run date) on `date` at `frequency`. */
export async function generatedRuns(
  companyId: string, templateId: string, date: string, frequency: string, lastRunDate: string | null,
): Promise<GeneratedRuns> {
  const unit = frequencyPeriodUnit(frequency);
  const rows = (await sql`
    SELECT
      MAX(j.entry_date::TEXT) FILTER (WHERE j.live AND date_trunc(${unit}::TEXT, j.entry_date) = date_trunc(${unit}::TEXT, ${date}::DATE))
        AS clash,
      MAX(j.entry_date::TEXT) FILTER (WHERE j.live) AS last_live,
      COUNT(*) AS linked,
      (${lastRunDate}::DATE IS NOT NULL
        AND date_trunc(${unit}::TEXT, ${date}::DATE) = date_trunc(${unit}::TEXT, ${lastRunDate}::DATE)) AS same_as_last_run
    FROM (
      SELECT entry_date,
             (status IN ('draft', 'posted') AND reversed_at IS NULL AND reversal_of_id IS NULL) AS live
      FROM gl_journal_entries
      WHERE company_id = ${companyId}::UUID AND source = 'auto_recurring' AND source_record_id = ${templateId}::UUID
    ) j
  `) as DbRow[];
  const r = rows[0]!;
  const linked = Number(r.linked) > 0;
  if (linked) {
    return { clash: r.clash === null ? null : String(r.clash), lastGenerated: r.last_live === null ? null : String(r.last_live), linked };
  }
  return { clash: r.same_as_last_run === true ? lastRunDate : null, lastGenerated: lastRunDate, linked };
}

/** The refusal for a run (or next run date) on `date` whose period `runs.clash` already holds. */
export function periodGeneratedError(date: string, frequency: string, runs: GeneratedRuns): RecurringJournalPeriodGeneratedError {
  return new RecurringJournalPeriodGeneratedError(
    `This template last generated on ${runs.lastGenerated ?? runs.clash}: ${frequencyPeriodLabel(date, frequency)} has `
    + `already been generated for this template — choose a date in a later ${frequencyPeriodUnit(frequency)} (post a `
    + 'manual journal for a second run).',
  );
}

/** Refuse a run on `dueDate` in a period the template already generated (before the claim, under its lock). */
export async function assertPeriodNotGenerated(companyId: string, templateId: string, dueDate: string, row: DbRow): Promise<void> {
  const frequency = String(row.frequency);
  const runs = await generatedRuns(companyId, templateId, dueDate, frequency,
    row.last_run_date === null || row.last_run_date === undefined ? null : String(row.last_run_date));
  if (runs.clash !== null) throw periodGeneratedError(dueDate, frequency, runs);
}
