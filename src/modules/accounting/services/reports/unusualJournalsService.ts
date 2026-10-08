/**
 * Unusual journal entries for the board pack's page 11.
 *
 * Two patterns a director can act on directly, read straight off posted
 * journals for one company and one window:
 *   - a large round-number amount, which tends to be an estimate standing in
 *     for an actual;
 *   - an entry recorded well after the date it claims to be dated, which
 *     tends to mean a period that was already reported on has since moved —
 *     except where it was recorded in a bulk load (`BULK_LOAD_MIN`), which
 *     is a ledger being loaded or rebuilt rather than a period moving. Those
 *     are counted and returned, never silently dropped.
 *
 * This is not a replacement for `anomalyDetectionService`'s statistical
 * checks (Benford's Law, z-score outliers) — those are pure functions over
 * whatever transactions a caller hands them. This is the company-scoped,
 * database-backed read the board pack needs, restricted to the two patterns
 * that are directly actionable from a board seat.
 */

import { sql } from '@/lib/neon';
import type { PeriodWindow } from './priorPeriod';
import { isDocumentPosting } from './journalSourceKinds';

export type UnusualJournalReason = 'round_number' | 'backdated';

/**
 * WHAT THE BACKDATING TEST SKIPPED, so the pack can say so.
 *
 * Null where it skipped nothing. Days are South African calendar dates,
 * `YYYY-MM-DD`.
 */
export interface BulkLoadedJournals {
  /** Journals in the window, recorded late on a bulk-load day, that the
   *  backdating test did not flag. A round number among them is still flagged
   *  as one and is not counted here. */
  journals: number;
  /** Distinct bulk-load days those journals were recorded on. */
  days: number;
  firstRecorded: string;
  lastRecorded: string;
  /** The earliest date any of them carries, `YYYY-MM-DD` — within the
   *  window, since only the window's journals are read: how far back into the
   *  reported period the load reached, not into periods before it. */
  oldestEntryDate: string;
}

export interface UnusualJournals {
  flags: UnusualJournalFlag[];
  bulkLoaded: BulkLoadedJournals | null;
}

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
export const BACKDATE_DAYS = 5;

/**
 * A DAY ON WHICH THE COMPANY RECORDED THIS MANY BACKDATED JOURNALS IS A BULK
 * LOAD, and its journals are not tested for late recording.
 *
 * Velocity Fibre's ledger was rebuilt from source documents in September 2026
 * and the board pack printed "19588 matters": every reloaded journal was, by
 * construction, recorded long after its date. Nothing on the row says
 * "reload" — `source` reads `auto_supplier_invoice` like any day's — so the
 * mark is the recording day. Measured on the production copy of 18 September
 * 2026 across all four tenants: a day that recorded backdated journals
 * recorded ONE (ISAFlow Demo's 4 July and 28 August, Brightsphere's 31
 * August) or THIRTEEN AND UP (every Velocity reload day, and Brightsphere's
 * and the demo's own imports). Ten sits in the gap.
 *
 * Counted over the COMPANY's day, not the window's share of it: a monthly
 * pack sees a few journals of a reload whose bulk is dated before it opens.
 */
export const BULK_LOAD_MIN = 10;

/** SAST is UTC+2 all year — South Africa keeps no daylight saving. */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

/** The South African calendar day a journal was recorded on. */
function recordedOn(createdAt: Date): string {
  return new Date(createdAt.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days between the date a journal carries and when it was recorded —
 *  past `BACKDATE_DAYS`, it is backdated. Measured from UTC midnight of the
 *  entry date, as it always was; the recording DAY a load is grouped by is
 *  SAST (`recordedOn`). One lateness test, for the window's journals and for
 *  the recording-day census alike. */
function isBackdated(entryDate: string, createdAt: Date): boolean {
  const daysLate = Math.floor(
    (createdAt.getTime() - new Date(`${entryDate}T00:00:00.000Z`).getTime()) / (1000 * 60 * 60 * 24),
  );
  return daysLate > BACKDATE_DAYS;
}

function toDateOnly(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * The recording days, among `days`, on which the company recorded at least
 * `BULK_LOAD_MIN` backdated posted journals of ANY date.
 *
 * The rows come back whole and are classified by `isBackdated` here, so the
 * census and the flag share one definition of late rather than a second one
 * written in SQL. On a reload that is every reloaded journal — 18 462 rows of
 * two columns for Velocity — and on an ordinary ledger the handful recorded
 * on the days something was posted late.
 */
async function bulkLoadDays(companyId: string, days: string[]): Promise<Set<string>> {
  const rows = (await sql`
    SELECT je.entry_date, je.created_at
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND (je.created_at AT TIME ZONE 'Africa/Johannesburg')::DATE = ANY(${days}::DATE[])
  `) as Array<Record<string, unknown>>;

  const backdatedOn = new Map<string, number>();
  for (const row of rows) {
    const createdAt = toDate(row.created_at);
    if (!isBackdated(toDateOnly(row.entry_date), createdAt)) continue;
    const day = recordedOn(createdAt);
    backdatedOn.set(day, (backdatedOn.get(day) ?? 0) + 1);
  }
  return new Set([...backdatedOn].filter(([, n]) => n >= BULK_LOAD_MIN).map(([day]) => day));
}

export async function getUnusualJournals(
  companyId: string,
  window: PeriodWindow,
): Promise<UnusualJournals> {
  const rows = (await sql`
    SELECT
      je.id,
      je.entry_number,
      je.entry_date,
      je.description,
      je.source,
      je.created_at,
      COALESCE(SUM(jl.debit), 0) AS amount,
      -- A transfer journal is the bank line's amount only when a line points at it (journalSourceKinds).
      (tl.transfer_journal_entry_id IS NOT NULL) AS bank_line_backed
    FROM gl_journal_entries je
    -- THE LINES ARE SCOPED TOO, not only the entry they hang off. The FK
    -- makes it redundant today and the root CLAUDE.md rule is "ALWAYS add
    -- company_id to every DB query" for the day it is not: SUM(jl.debit)
    -- feeds a matter printed on page 11 of a board pack, and every sibling
    -- query on this branch (packTrendService, financialFiguresService)
    -- scopes je, jl and ga alike.
    JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id
     AND jl.company_id = ${companyId}::UUID
    LEFT JOIN (
      SELECT DISTINCT transfer_journal_entry_id FROM bank_transactions
      WHERE company_id = ${companyId}::UUID AND transfer_journal_entry_id IS NOT NULL
    ) tl ON tl.transfer_journal_entry_id = je.id
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date BETWEEN ${window.start}::DATE AND ${window.end}::DATE
    GROUP BY je.id, je.entry_number, je.entry_date, je.description, je.source, je.created_at, tl.transfer_journal_entry_id
    -- A TOTAL ORDER, BECAUSE THE PLAN IS NOT ALLOWED TO PICK WHICH MATTER A
    -- BOARD READS.
    --
    -- These rows become page 11's matters, ranked by exposure, and the page
    -- prints only what fits. With no ORDER BY, two journals of the SAME
    -- amount were ordered by whatever the grouped scan returned -- and
    -- Brightsphere has two at exactly R161 000.00. Adding a predicate to the
    -- join above was enough to change the plan and swap which of them a
    -- director saw, on unchanged data. Same class as the system-account
    -- resolver that let heap order decide a map.set.
    --
    -- je.id last, and it is what makes this total: entry_number is nullable,
    -- so it cannot be the final key. Amount then date is the order the page
    -- itself argues for -- largest exposure first, most recent of an equal
    -- pair first -- so the tie-break is meaningful rather than merely stable.
    ORDER BY COALESCE(SUM(jl.debit), 0) DESC, je.entry_date DESC, je.entry_number, je.id
  `) as Array<Record<string, unknown>>;

  const journals = rows.map((row) => {
    const entryDate = toDateOnly(row.entry_date);
    const createdAt = toDate(row.created_at);
    const amount = Number(row.amount);
    // `created_at` is nullable: a journal with no recording time cannot be
    // shown to be late, and must not throw — that would take the pack down.
    const recorded = row.created_at !== null && !Number.isNaN(createdAt.getTime());
    return {
      row,
      entryDate,
      amount,
      recordedOn: recorded ? recordedOn(createdAt) : '',
      isRoundNumber: !isDocumentPosting(row.source, row.bank_line_backed === true)
        && amount >= ROUND_NUMBER_FLOOR && amount % 1000 === 0,
      isBackdated: recorded && isBackdated(entryDate, createdAt),
    };
  });

  // Asked only where something was recorded late, and only about the days it
  // was recorded on.
  const lateDays = [...new Set(journals.filter((j) => j.isBackdated).map((j) => j.recordedOn))].sort();
  const bulkDays = lateDays.length === 0 ? new Set<string>() : await bulkLoadDays(companyId, lateDays);

  const flags: UnusualJournalFlag[] = [];
  const skippedOn: string[] = [];
  let oldestEntryDate: string | null = null;
  for (const j of journals) {
    const inBulkLoad = j.isBackdated && bulkDays.has(j.recordedOn);
    if (inBulkLoad && !j.isRoundNumber) {
      skippedOn.push(j.recordedOn);
      if (oldestEntryDate === null || j.entryDate < oldestEntryDate) oldestEntryDate = j.entryDate;
    }
    const isBackdatedMatter = j.isBackdated && !inBulkLoad;
    if (!j.isRoundNumber && !isBackdatedMatter) continue;

    flags.push({
      entryId: j.row.id as string,
      entryNumber: (j.row.entry_number as string | null) ?? null,
      entryDate: j.entryDate,
      description: (j.row.description as string | null) ?? null,
      amount: j.amount,
      // Round-number takes priority when an entry qualifies as both — it is
      // the more specific, more actionable claim of the two.
      reason: j.isRoundNumber ? 'round_number' : 'backdated',
    });
  }

  const skippedDays = [...new Set(skippedOn)].sort();
  return {
    flags,
    bulkLoaded: skippedOn.length === 0 ? null : {
      journals: skippedOn.length,
      days: skippedDays.length,
      firstRecorded: skippedDays[0]!,
      lastRecorded: skippedDays[skippedDays.length - 1]!,
      oldestEntryDate: oldestEntryDate!,
    },
  };
}
