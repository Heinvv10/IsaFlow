/**
 * The entry number a year's closing journal takes, walking past closes that were reversed (G-06).
 *
 * `uq_gl_je_company_entry_number` is unique on (company_id, entry_number) with no predicate, and
 * the first close takes `YE-<year>`. Reversing it keeps that row (reversal marks `reversed_at`,
 * never deletes), so a year whose close was undone could never be closed again under the same
 * number, and used to be reported `alreadyClosed` because the row is still `status = 'posted'`.
 * Each earlier close that was reversed is skipped: the next close is `YE-<year>-R1`, then `-R2`.
 *
 * "Reversed" is read from the reversal CHAIN, not from `reversed_at` alone: reversing the reversal
 * (C <- R <- R2) leaves `reversed_at` on C yet reinstates it, and walking past a reinstated close
 * would post a second, empty one over a flat P&L. A close with an even number of posted reversals
 * stands (0 as well: a claim with no contra reads as standing, as `journalStandsFragment` does).
 *
 * Only a `year_end` row with a reversal in force is skipped. A draft, a legacy `status = 'reversed'`
 * header or a squatter of another source still holds its number and is classified by
 * `classifyClosingJournal`, exactly as before.
 */

import { sql } from '@/lib/neon';
import { findClosingJournal } from './yearEndJournalPoster';
import { YEAR_END_JOURNAL_SOURCE } from './yearEndJournalSource';

/** A year closed, reversed and re-closed this many times is a loop, not a correction. */
const MAX_RECLOSES = 25;
/** A reversal chain longer than this is forged or looped; the walk stops and reads it as standing. */
const MAX_CHAIN = 20;

export class TooManyRecloses extends Error {
  readonly code = 'YEAR_END_TOO_MANY_RECLOSES' as const;
  constructor(readonly baseNumber: string) {
    super(`Closing journal ${baseNumber} has been reversed more than ${MAX_RECLOSES} times`);
    this.name = 'TooManyRecloses';
  }
}

/**
 * A reversal chain longer than `MAX_CHAIN` is forged or looped. Reading it as "standing" would be a guess, and the
 * guess decides whether a second close is posted over a flat P&L, so the walk refuses instead.
 */
export class ClosingChainTooLong extends Error {
  readonly code = 'YEAR_END_CLOSE_CHAIN_TOO_LONG' as const;
  constructor(readonly entryNumber: string) {
    super(`The reversal chain of closing journal ${entryNumber} is too long to read; a person has to inspect it`);
    this.name = 'ClosingChainTooLong';
  }
}

export interface CurrentClosingJournal {
  /** The number this close writes under (or, with `existing`, the number it already holds). */
  entryNumber: string;
  /** The row holding `entryNumber`, or null when the number is free. */
  existing: Record<string, unknown> | null;
}

export function reclosingNumber(baseNumber: string, attempt: number): string {
  return attempt === 0 ? baseNumber : `${baseNumber}-R${attempt}`;
}

/** Posted reversals in force on `row`: C <- R <- R2 is two, so C stands again. */
async function reversalsInForce(companyId: string, row: Record<string, unknown>): Promise<number> {
  let current = String(row.id);
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    const next = (await sql`
      SELECT id FROM gl_journal_entries
      WHERE company_id = ${companyId}::UUID AND reversal_of_id = ${current}::UUID AND status = 'posted'
      LIMIT 1
    `) as Array<{ id: string }>;
    if (next.length === 0) return depth;
    current = String(next[0]!.id);
  }
  throw new ClosingChainTooLong(String(row.entry_number ?? row.id));
}

/** True when the row is a year-end close that stands undone: reversed, and not reinstated since. */
async function isUndoneClose(companyId: string, row: Record<string, unknown>): Promise<boolean> {
  if (String(row.source) !== YEAR_END_JOURNAL_SOURCE || !row.reversed_at) return false;
  return (await reversalsInForce(companyId, row)) % 2 === 1;
}

export async function findCurrentClosingJournal(
  companyId: string,
  baseNumber: string,
): Promise<CurrentClosingJournal> {
  for (let attempt = 0; attempt <= MAX_RECLOSES; attempt += 1) {
    const entryNumber = reclosingNumber(baseNumber, attempt);
    const existing = await findClosingJournal(companyId, entryNumber);
    if (!existing || !(await isUndoneClose(companyId, existing))) {
      // A reinstated close stands even though reversed_at is still set on it.
      const reinstated = existing !== null && Boolean(existing.reversed_at)
        && String(existing.source) === YEAR_END_JOURNAL_SOURCE;
      return { entryNumber, existing: reinstated ? { ...existing, reinstated: true } : existing };
    }
  }
  throw new TooManyRecloses(baseNumber);
}
