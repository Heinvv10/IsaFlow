/**
 * The entry number a year's closing journal takes, walking past closes that were reversed (G-06).
 *
 * `uq_gl_je_company_entry_number` is unique on (company_id, entry_number) with no predicate, and
 * the first close takes `YE-<year>`. Reversing it keeps that row (reversal marks `reversed_at`,
 * never deletes), so a year whose close was undone could never be closed again under the same
 * number, and used to be reported `alreadyClosed` because the row is still `status = 'posted'`.
 * Each earlier close that was reversed is skipped: the next close is `YE-<year>-R1`, then `-R2`.
 *
 * Only a `year_end` row with `reversed_at` set is skipped. A draft, a legacy `status = 'reversed'`
 * header or a squatter of another source still holds its number and is classified by
 * `classifyClosingJournal`, exactly as before.
 */

import { findClosingJournal } from './yearEndJournalPoster';
import { YEAR_END_JOURNAL_SOURCE } from './yearEndJournalSource';

/** A year closed, reversed and re-closed this many times is a loop, not a correction. */
const MAX_RECLOSES = 25;

export interface CurrentClosingJournal {
  /** The number this close writes under (or, with `existing`, the number it already holds). */
  entryNumber: string;
  /** The row holding `entryNumber`, or null when the number is free. */
  existing: Record<string, unknown> | null;
}

export function reclosingNumber(baseNumber: string, attempt: number): string {
  return attempt === 0 ? baseNumber : `${baseNumber}-R${attempt}`;
}

function isReversedClose(row: Record<string, unknown>): boolean {
  return String(row.source) === YEAR_END_JOURNAL_SOURCE && Boolean(row.reversed_at);
}

export async function findCurrentClosingJournal(
  companyId: string,
  baseNumber: string,
): Promise<CurrentClosingJournal> {
  for (let attempt = 0; attempt <= MAX_RECLOSES; attempt += 1) {
    const entryNumber = reclosingNumber(baseNumber, attempt);
    const existing = await findClosingJournal(companyId, entryNumber);
    if (!existing || !isReversedClose(existing)) return { entryNumber, existing };
  }
  throw new Error(`Closing journal ${baseNumber} has been reversed more than ${MAX_RECLOSES} times`);
}
