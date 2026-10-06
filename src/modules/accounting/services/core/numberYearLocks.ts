/**
 * Cross-year multi-journal runs take every year's journal key up front, ascending (DOCNUM follow-up (c),
 * brk-docnum F3).
 *
 * Each journal number takes 857's key ('<company>:<year>', 857) and holds it to commit. A run that posts a 2026
 * journal and then a 2025 one, against any transaction that holds 2025 and then wants 2026, deadlocks (40P01) —
 * and the bulk posters walk their lines in id order, so their year order follows the uuids. A run whose journals
 * span two or more years therefore takes all of their keys, in ascending year order, on the request transaction,
 * OUTSIDE any per-line savepoint and BEFORE its first journal. A single-year run takes nothing extra: its one key
 * is taken by the journal trigger as before.
 *
 * ROWS FIRST (round 2, brk-numrace M3). Every single-row writer locks its row (a bank line, a bill) and THEN numbers
 * its journal. A bulk run that took the year keys before its rows inverted that order and deadlocked against a
 * single writer of one of its rows. `claimRowsThenLockYears` claims the run's rows, in the order the run walks them
 * and with the single path's own lock function, and only then takes the year keys.
 *
 * Bounds. The lock waits at most 5 s (migration 864): a 55P03 is raised before anything was posted, so the WHOLE run
 * is retryable (routes 503 + Retry-After, MCP "retry in a moment"). More than MAX_RUN_YEARS distinct years is
 * refused before any lock or write (`YearSpanTooWideError`, a 400): each key is an entry in the cluster-wide shared
 * lock table, and one run naming thousands of years exhausted it for every tenant (sec-numrace S1, 53200).
 */
import { withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { isHeldRowError } from '@/lib/lockTimeout';
import { JOURNAL_NUMBER_SEED, takeCompanyNumberLock } from './numberLock';
import { MAX_RUN_YEARS, YearSpanTooWideError } from './yearSpanRefusal';

export { MAX_RUN_YEARS, YearSpanTooWideError, isYearSpanTooWide } from './yearSpanRefusal';

function distinctYears(years: Iterable<number>): number[] {
  const distinct = [...new Set(years)].filter((y) => Number.isInteger(y)).sort((a, b) => a - b);
  if (distinct.length > MAX_RUN_YEARS) throw new YearSpanTooWideError(distinct.length);
  return distinct;
}

/** Takes the journal key of every distinct year, ascending, when there are two or more (at most MAX_RUN_YEARS). */
export async function lockNumberYears(companyId: string, years: Iterable<number>): Promise<void> {
  const distinct = distinctYears(years);
  if (distinct.length < 2) return;
  for (const year of distinct) await takeCompanyNumberLock(companyId, String(year), JOURNAL_NUMBER_SEED);
}

/** One row a run will post for, and the years its journals can be dated in. */
export interface YearClaim { id: string; years: readonly number[] }

/**
 * Rows, then years. When the run's years (its rows' plus `extraYears`) span two or more, claims each row — in the
 * order given, which must be the order the run walks them — with `claimRow` (the single path's own lock), each in
 * its own savepoint, and only then takes the year keys. A row a peer holds past its lock's bound is left unclaimed
 * (the run's own per-row lock then answers it as it always did) but its years stay in the set. Single-year: nothing.
 */
export async function claimRowsThenLockYears(
  companyId: string,
  rows: readonly YearClaim[],
  claimRow: (id: string) => Promise<unknown>,
  extraYears: readonly number[] = [],
  isHeld: (err: unknown) => boolean = isHeldRowError,
): Promise<void> {
  const years = distinctYears([...rows.flatMap((r) => r.years), ...extraYears]);
  if (years.length < 2) return;
  for (const [n, row] of rows.entries()) {
    try {
      await withSavepoint(`year_claim_${n}`, () => claimRow(row.id));
    } catch (err) {
      if (!isHeld(err)) throw err;
    }
  }
  await lockNumberYears(companyId, years);
}

/** The calendar year a journal dated `date` is numbered in (EXTRACT(YEAR FROM entry_date)); NaN when undated. */
export function journalYearOf(date: string | Date | null | undefined): number {
  const day = date ? fmtDate(date) : '';
  return day ? Number(day.slice(0, 4)) : Number.NaN;
}
