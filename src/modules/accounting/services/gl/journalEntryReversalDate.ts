/**
 * Which date the contra of a reversal carries.
 *
 * Split out of journalEntryPostingService so that file stays inside the
 * 300-line cap. The rules are unchanged and still pinned by
 * tests/unit/services/journalEntryReversalDate.test.ts.
 */

import { fmtDate } from '@/lib/fmtDate';
import { getPeriodStatusForDate } from './periodStatusService';

/**
 * A correction belongs in the period it corrects. Dating every reversal to
 * TODAY moved the correction into a later period than the entry it undoes: the
 * two no longer net to zero in any period-bounded report, and when the pair
 * straddles a VAT period the return for the original period stays overstated
 * while the next one is understated.
 *
 * So: date the reversal to the ORIGINAL entry_date when that period is still
 * open, and fall back to today only when it is not. The fallback is what the
 * previous unconditional-today rule was really protecting — a closed original
 * period must not make old documents permanently un-cancellable, and
 * postJournalEntry would throw ClosedFiscalPeriodError.
 *
 * All of that is the DEFAULT. A caller may name the date instead, and when it
 * does the original period is not even consulted: the fallback it drives is
 * precisely what is being overridden.
 */

/** A calendar date, and a real one — `2026-02-30` matches the shape but is not a day. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Which date the contra carries.
 *
 * Without an explicit date this is the default described above: the original
 * entry's date when its period is open, today when it is closed.
 *
 * With one, the caller wins over the ORIGINAL period's status — that fallback is
 * exactly what people ask to override (correcting a closed month from the open
 * one). Three guards:
 *
 *   - the value must be a real YYYY-MM-DD day. It is interpolated into a DATE
 *     column, where a malformed value raises 22P02 and reaches the caller as a
 *     generic failure that names nothing. '2026-02-30' matches the shape and is
 *     not a day, so the date is constructed and compared back.
 *   - it must not PRECEDE the entry being reversed. A correction landing before
 *     the thing it corrects is nonsense in every period-bounded report.
 *   - its fiscal period must EXIST and be open.
 *
 * That third guard was initially left to postJournalEntry, on the reasoning that
 * a second check could only drift from the one governing the write. That
 * reasoning was WRONG, and an adversarial review caught it:
 *
 *   postJournalEntry guards its closed-period check behind
 *   `if (entry.fiscalPeriodId)`, and createJournalEntry leaves that column NULL
 *   when NO fiscal_periods row covers the entry date. So a date in a fiscal
 *   year nobody has created yet — '9999-12-31', or a typo'd year — skipped the
 *   check entirely and POSTED, with fiscal_period_id NULL, permanently outside
 *   every period-bounded report: trial balance, VAT201, AFS.
 *
 * The underlying NULL-period hole is older than this parameter and reachable by
 * any caller of createJournalEntry. What this parameter changed is that an
 * arbitrary date became remotely selectable, so it is closed HERE, on the path
 * that introduced the reach. getPeriodStatusForDate already distinguishes
 * `no_period` from `closed`, and the two get different messages because the
 * remedies differ: create the fiscal year, versus re-open the period.
 */
/**
 * Exported so a caller that must distinguish a REFUSAL from a FAILURE can run
 * these guards first. It is read-only, so calling it twice costs two period
 * lookups and nothing else. `apply`-style MCP tools need this: only pre-write
 * validation may return a `toolError`, and once `reverseJournalEntry` has been
 * entered a caller cannot tell a bad date from a failure after the contra
 * posted.
 */
export async function resolveReversalDate(
  companyId: string,
  originalDate: string,
  requested: string | undefined,
): Promise<string> {
  if (requested === undefined) {
    const originalPeriod = await getPeriodStatusForDate(companyId, originalDate);
    // fmtDate(new Date()), not toISOString — between 00:00 and 02:00 SAST the
    // latter stamps yesterday.
    return originalPeriod === 'open' ? originalDate : fmtDate(new Date());
  }
  if (!isCalendarDate(requested)) {
    throw new Error(`reversal_date must be a real calendar date in YYYY-MM-DD format, got "${requested}"`);
  }
  // String comparison is safe and total for zero-padded ISO dates.
  if (requested < originalDate) {
    throw new Error(
      `reversal_date ${requested} is before the entry it reverses (${originalDate}). `
      + 'A correction cannot be dated earlier than the entry it corrects.',
    );
  }
  // The TARGET date's period, not the original's. Refused BEFORE
  // createJournalEntry inserts anything, so there is no draft to clean up and
  // the caller is told which of the two problems it has.
  const targetPeriod = await getPeriodStatusForDate(companyId, requested);
  if (targetPeriod === 'no_period') {
    throw new Error(
      `No fiscal period covers reversal_date ${requested}. `
      + 'Create the fiscal year first — posting outside every period would leave the '
      + 'reversal invisible to the trial balance, the VAT201 and the AFS.',
    );
  }
  if (targetPeriod !== 'open') {
    throw new Error(`The fiscal period covering reversal_date ${requested} is closed.`);
  }
  return requested;
}
