/**
 * Fiscal-period STATE for a date — the "can I post on this day?" question,
 * as distinct from fiscalPeriodService's "which period row is this?".
 *
 * Its own file rather than part of fiscalPeriodService because that file is at
 * the project's 300-line ceiling, and because this is the narrower question:
 * callers here never want the period id, only whether the date is postable.
 *
 * Two callers: bank-rules auto-post pre-filters candidates with it (so it
 * never inserts a draft JE that postJournalEntry will refuse, which would
 * leave orphan drafts in the GL), and reverseJournalEntry uses it to decide
 * whether a correction can be dated back into the period it corrects.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';

/**
 * Discriminated period state for a given entry date.
 * - `open`       — a covering fiscal_periods row exists and status='open'
 * - `closed`     — a covering row exists but status is 'closed' or 'locked'
 * - `no_period`  — no row covers this date at all (fiscal year not created)
 *
 * The `no_period` case must be reported separately from `closed`: the remedy
 * differs (create the fiscal year vs. re-open the period), and conflating
 * them in the UI sent users in circles when their periods were all open but
 * the year hadn't been created.
 */
export type PeriodStatus = 'open' | 'closed' | 'no_period';

export async function getPeriodStatusForDate(
  companyId: string,
  entryDate: string | Date,
): Promise<PeriodStatus> {
  // fmtDate, never toISOString: on this UTC+2 host toISOString() reports the
  // previous day for a Date at local midnight, which would resolve the WRONG
  // period at every month boundary.
  const date = fmtDate(entryDate);
  const rows = (await sql`
    SELECT status FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID
      AND start_date <= ${date}::DATE
      AND end_date   >= ${date}::DATE
    LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) return 'no_period';
  return String(rows[0]!.status) === 'open' ? 'open' : 'closed';
}
