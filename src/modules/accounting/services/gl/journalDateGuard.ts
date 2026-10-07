/**
 * The ledger-date window (utils/journalDateWindow) on every path that writes a tenant's date: Postgres reads the date
 * (`::date`, exactly as the INSERT would), the window is applied to the day it returns, and that day is what the path
 * stores. A string Postgres cannot cast is handed back unchanged, so it fails exactly as it did before the window.
 *
 * `ledgerEntryDay` is createJournalEntry's funnel check (sec-numrace S4) and the year-end closing journal's, which
 * INSERTs itself.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { JournalDateRefusedError, journalDayWindowError } from '../../utils/journalDateWindow';

/**
 * A canonical day ('2025-03-31') is what Postgres reads it as under every DateStyle (an invalid one, '2025-02-30',
 * still fails at the INSERT as before), so it needs no round trip; every other form, and a Date, is cast.
 */
const CANONICAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A data exception (SQLSTATE class 22): Postgres cannot read the value as a date. */
const isCastError = (err: unknown) =>
  typeof (err as { code?: unknown })?.code === 'string' && String((err as { code: string }).code).startsWith('22');

/**
 * The day as YYYY-MM-DD whatever the session's DateStyle (sec: 'SQL, DMY' prints 31/12/2199): to_char, with ' BC'
 * kept for a BC date and ±infinity (to_char gives NULL) as its own text — both then fail the window.
 */
async function castDay(value: string | Date): Promise<string | null> {
  if (typeof value === 'string' && CANONICAL_DAY.test(value)) return value;
  try {
    const rows = (await withSavepoint('ledger_day', () => sql`
      SELECT COALESCE(replace(to_char(${value}::date, 'YYYY-MM-DD BC'), ' AD', ''), ${value}::date::text) AS d
    `)) as { d: string }[];
    return rows[0]!.d;
  } catch (err) {
    if (!isCastError(err)) throw err;
    return null;
  }
}

/** The day Postgres stores for each string, or null where it cannot cast it. At most one query unless a cast fails. */
export async function ledgerDaysOf(inputs: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const s of inputs) if (CANONICAL_DAY.test(s)) out.set(s, s);
  const distinct = [...new Set(inputs)].filter((s) => !out.has(s));
  if (distinct.length === 0) return out;
  try {
    const rows = (await withSavepoint('ledger_days', () => sql`
      SELECT s, COALESCE(replace(to_char(s::date, 'YYYY-MM-DD BC'), ' AD', ''), s::date::text) AS d
      FROM unnest(${distinct}::text[]) AS s`)) as { s: string; d: string }[];
    for (const r of rows) out.set(r.s, r.d);
    return out;
  } catch (err) {
    if (!isCastError(err)) throw err;
  }
  for (const s of distinct) out.set(s, await castDay(s));
  return out;
}

/** The day a journal dated `entryDate` is stored on, or JournalDateRefusedError when it is outside the window. */
export async function ledgerEntryDay(entryDate: string): Promise<string> {
  const day = await castDay(entryDate);
  if (day === null) return entryDate;
  const reason = journalDayWindowError(day);
  if (reason) throw new JournalDateRefusedError(reason);
  return day;
}
