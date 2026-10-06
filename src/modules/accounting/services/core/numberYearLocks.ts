/**
 * Cross-year multi-journal runs: ORDERED LAZY (DOCNUM follow-up (c), brk-docnum F3; Hein's ruling 2026-10-06, which
 * replaced round 1-2's "every year's key up front" on brk-numrace N1 evidence).
 *
 * Each journal number takes 857's key ('<company>:<year>', 857) and holds it to commit. A run that posts a 2026
 * journal and then a 2025 one, against any transaction that holds 2025 and then wants 2026, deadlocks (40P01) — the
 * bulk posters used to walk their elements in id order, so their year order followed the uuids. Now:
 *
 *   1. `orderByPredictedYears` — a run processes its elements by (min predicted year, then the caller's own order),
 *      so its keys are reached ascending. Two runs over overlapping rows still meet them in one global order:
 *      predicted years are deterministic. Each element's predicted set must be a superset on the LOW side — an
 *      element never numbers below its predicted min.
 *   2. `YearKeyCursor` — a SINGLE-year element takes nothing up front: its key is taken where base takes it, by its
 *      own posting, after its own row locks. Before a MULTI-year element (a late-claim companion, a VAT-roll
 *      reversal, a provisional reclass…) the cursor takes every year from its min to its max that it has not taken,
 *      ascending, before the element's rows. Safe because the held set at or above the current min is always one
 *      contiguous range, so every acquisition is ascending.
 *
 * Up-front row claims (rounds 2-3, `claimRowsThenLockYears`) are gone: they existed only to serve keys-up-front, and
 * claimed only each element's FIRST lock (brk-numrace N1: a held claim, a contact, a chain head still landed after
 * the keys). bank-transactions-bulk-commit is the one two-pass request: see bank/bulkCommitRulePass.
 *
 * Bounds. A key waits at most 5 s (migration 864): 55P03 → routes 503 + Retry-After, MCP "retry in a moment". A run
 * whose union of predicted years (a multi-year element counts its whole min..max range) exceeds MAX_RUN_YEARS is
 * refused before any lock or write (`YearSpanTooWideError`, a 400): every key it reaches is held to its end, in the
 * cluster-wide shared lock table (sec-numrace S1, 53200).
 */
import { fmtDate } from '@/lib/fmtDate';
import { JOURNAL_NUMBER_SEED, takeCompanyNumberLock } from './numberLock';
import { MAX_RUN_YEARS, YearSpanTooWideError } from './yearSpanRefusal';

export { MAX_RUN_YEARS, YearSpanTooWideError, isYearSpanTooWide } from './yearSpanRefusal';

function distinctYears(years: Iterable<number>): number[] {
  const distinct = [...new Set(years)].filter((y) => Number.isInteger(y)).sort((a, b) => a - b);
  if (distinct.length > MAX_RUN_YEARS) throw new YearSpanTooWideError(distinct.length);
  return distinct;
}

/** Refuses (YearSpanTooWideError, 400) a set of more than MAX_RUN_YEARS distinct years — before any lock or write. */
export function assertRunYears(years: Iterable<number>): void {
  distinctYears(years);
}

/** Takes the journal key of every distinct year, ascending, when there are two or more (at most MAX_RUN_YEARS). */
export async function lockNumberYears(companyId: string, years: Iterable<number>): Promise<void> {
  const distinct = distinctYears(years);
  if (distinct.length < 2) return;
  for (const year of distinct) await takeCompanyNumberLock(companyId, String(year), JOURNAL_NUMBER_SEED);
}

/** Every year a multi-year element's cursor may take: its whole min..max range. */
function reach(years: readonly number[]): number[] {
  const ys = distinctYears(years);
  if (ys.length < 2) return ys;
  return Array.from({ length: ys[ys.length - 1]! - ys[0]! + 1 }, (_, i) => ys[0]! + i);
}

/**
 * The run's processing order: by min predicted year (an element with none last), stable — ties keep the caller's
 * order (its id or lock-group sort). Refuses a run whose reach exceeds MAX_RUN_YEARS, before any lock or write.
 */
export function orderByPredictedYears<T>(items: readonly T[], yearsOf: (item: T) => readonly number[]): T[] {
  distinctYears(items.flatMap((item) => reach(yearsOf(item))));
  const keyed = items.map((item, i) => {
    const ys = yearsOf(item).filter((y) => Number.isInteger(y));
    return { item, i, min: ys.length > 0 ? Math.min(...ys) : Number.POSITIVE_INFINITY };
  });
  return keyed.sort((a, b) => (a.min !== b.min ? a.min - b.min : a.i - b.i)).map((k) => k.item);
}

/** The run's key cursor — see the header. Call `before(years)` OUTSIDE the element's savepoint, before its rows. */
export class YearKeyCursor {
  private readonly taken = new Set<number>();

  constructor(private readonly companyId: string) {}

  async before(years: readonly number[]): Promise<void> {
    const range = reach(years);
    if (range.length < 2) return;
    for (const year of range) {
      if (this.taken.has(year)) continue;
      await takeCompanyNumberLock(this.companyId, String(year), JOURNAL_NUMBER_SEED);
      this.taken.add(year);
    }
  }
}

/**
 * The year a journal dated `date` is numbered in — exactly the trigger's EXTRACT(YEAR FROM entry_date): every leading
 * digit (Postgres takes 5- to 7-digit years: '100000-01-01' is year 100000) and negative for a BC date
 * ('0044-03-15 BC' is -44). Counting the first four digits let 2000 distinct years pass the cap as two (sec-numrace
 * S2). NaN when undated or unparseable.
 */
export function journalYearOf(date: string | Date | null | undefined): number {
  const day = date ? fmtDate(date) : '';
  const m = /^(-?\d+)-\d{2}-\d{2}(\s+BC)?/i.exec(day.trim());
  if (!m) return Number.NaN;
  return m[2] ? -Number(m[1]) : Number(m[1]);
}
