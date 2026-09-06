/**
 * Unusual journal entries for the board pack's page 11.
 *
 * Two patterns a director can act on directly, read straight off posted
 * journals for one company and one window:
 *   - a large round-number amount, which tends to be an estimate standing in
 *     for an actual;
 *   - an entry recorded well after the date it claims to be dated, which
 *     tends to mean a period that was already reported on has since moved.
 *
 * This is not a replacement for `anomalyDetectionService`'s statistical
 * checks (Benford's Law, z-score outliers) — those are pure functions over
 * whatever transactions a caller hands them. This is the company-scoped,
 * database-backed read the board pack needs, restricted to the two patterns
 * that are directly actionable from a board seat.
 */

import { sql } from '@/lib/neon';
import type { PeriodWindow } from './priorPeriod';

export type UnusualJournalReason = 'round_number' | 'backdated';

export interface UnusualJournalFlag {
  entryId: string;
  entryNumber: string | null;
  entryDate: string;
  description: string | null;
  amount: number;
  reason: UnusualJournalReason;
}

/** Below this, a round number is unremarkable pocket change. */
const ROUND_NUMBER_FLOOR = 10_000;
/** More than this many days between the entry's own date and when it was
 *  actually recorded counts as backdated, not ordinary month-end lag. */
const BACKDATE_DAYS = 5;

function toDateOnly(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export async function getUnusualJournals(
  companyId: string,
  window: PeriodWindow,
): Promise<UnusualJournalFlag[]> {
  const rows = (await sql`
    SELECT
      je.id,
      je.entry_number,
      je.entry_date,
      je.description,
      je.created_at,
      COALESCE(SUM(jl.debit), 0) AS amount
    FROM gl_journal_entries je
    JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date BETWEEN ${window.start}::DATE AND ${window.end}::DATE
    GROUP BY je.id, je.entry_number, je.entry_date, je.description, je.created_at
  `) as Array<Record<string, unknown>>;

  const flags: UnusualJournalFlag[] = [];
  for (const row of rows) {
    const amount = Number(row.amount);
    const entryDate = toDateOnly(row.entry_date);
    const createdAt = toDate(row.created_at);

    const isRoundNumber = amount >= ROUND_NUMBER_FLOOR && amount % 1000 === 0;
    const daysLate = Math.floor(
      (createdAt.getTime() - new Date(`${entryDate}T00:00:00.000Z`).getTime()) / (1000 * 60 * 60 * 24),
    );
    const isBackdated = daysLate > BACKDATE_DAYS;

    if (!isRoundNumber && !isBackdated) continue;

    flags.push({
      entryId: row.id as string,
      entryNumber: (row.entry_number as string | null) ?? null,
      entryDate,
      description: (row.description as string | null) ?? null,
      amount,
      // Round-number takes priority when an entry qualifies as both — it is
      // the more specific, more actionable claim of the two.
      reason: isRoundNumber ? 'round_number' : 'backdated',
    });
  }
  return flags;
}
