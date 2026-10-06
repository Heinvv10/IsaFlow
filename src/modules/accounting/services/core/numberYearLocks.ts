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
 * The lock is bounded at 5 s (migration 864). A 55P03 here is raised before anything was posted, so the WHOLE run
 * is retryable: routes answer 503 + Retry-After, MCP tools the registry's "retry in a moment".
 */
import { fmtDate } from '@/lib/fmtDate';
import { JOURNAL_NUMBER_SEED, takeCompanyNumberLock } from './numberLock';

/** Takes the journal key of every distinct year, ascending, when there are two or more. */
export async function lockNumberYears(companyId: string, years: Iterable<number>): Promise<void> {
  const distinct = [...new Set(years)].filter((y) => Number.isInteger(y)).sort((a, b) => a - b);
  if (distinct.length < 2) return;
  for (const year of distinct) await takeCompanyNumberLock(companyId, String(year), JOURNAL_NUMBER_SEED);
}

/** The calendar year a journal dated `date` is numbered in (EXTRACT(YEAR FROM entry_date)); NaN when undated. */
export function journalYearOf(date: string | Date | null | undefined): number {
  const day = date ? fmtDate(date) : '';
  return day ? Number(day.slice(0, 4)) : Number.NaN;
}

/**
 * Every year a reversal of journals dated `originalDates` can be dated in, for the up-front lock. A named reversal
 * date is its one year. Otherwise each contra is dated on its original when that period is open, else today, and a
 * VAT-lock roll only moves it forward, to today at most — so every year from the earliest original's to the later
 * of the latest original's and this one (a superset: no reversal falls outside it). A RANGE, not just the originals'
 * years plus this one: a roll out of a locked December lands in the following January, which may be neither.
 * Cost of the superset: the run holds keys for years it may not post in, so other posts in those years wait (5 s,
 * then 503) for the run's whole transaction — only when its lines span two or more years or predate this year.
 */
export function reversalYears(
  originalDates: readonly (string | Date | null | undefined)[],
  reversalDate?: string,
): number[] {
  if (reversalDate) return [journalYearOf(reversalDate)];
  const known = originalDates.map(journalYearOf).filter((y) => Number.isInteger(y));
  if (known.length === 0) return [];
  const years: number[] = [];
  for (let y = Math.min(...known); y <= Math.max(...known, journalYearOf(new Date())); y++) years.push(y);
  return years;
}
