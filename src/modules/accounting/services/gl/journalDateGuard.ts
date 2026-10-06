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

/** A data exception (SQLSTATE class 22): Postgres cannot read the value as a date. */
const isCastError = (err: unknown) =>
  typeof (err as { code?: unknown })?.code === 'string' && String((err as { code: string }).code).startsWith('22');

async function castDay(value: string | Date): Promise<string | null> {
  try {
    const rows = (await withSavepoint('ledger_day', () => sql`SELECT ${value}::date::text AS d`)) as { d: string }[];
    return rows[0]!.d;
  } catch (err) {
    if (!isCastError(err)) throw err;
    return null;
  }
}

/** The day Postgres stores for each string, or null where it cannot cast it. One query unless one of them fails. */
export async function ledgerDaysOf(inputs: readonly string[]): Promise<Map<string, string | null>> {
  const distinct = [...new Set(inputs)];
  const out = new Map<string, string | null>();
  if (distinct.length === 0) return out;
  try {
    const rows = (await withSavepoint('ledger_days', () => sql`
      SELECT s, s::date::text AS d FROM unnest(${distinct}::text[]) AS s`)) as { s: string; d: string }[];
    for (const r of rows) out.set(r.s, r.d);
    return out;
  } catch (err) {
    if (!isCastError(err)) throw err;
  }
  for (const s of distinct) out.set(s, await castDay(s));
  return out;
}

/**
 * Nothing written yet in this transaction: no transaction id assigned. Conservative — a row lock assigns one too, so a
 * path that locks its document before its journal checks the document's date before the lock (customer invoice
 * approve, expense-claim post). pg_stat_xact_all_tables is no finer signal: a backend's unflushed counts from its
 * previous transactions show in it (measured on 16, brk-numrace F2).
 */
async function requestHasNotWritten(): Promise<boolean> {
  const rows = (await sql`SELECT pg_current_xact_id_if_assigned() IS NULL AS clean`) as { clean: boolean }[];
  return rows[0]?.clean === true;
}

/** The day a journal dated `entryDate` is stored on, or JournalDateRefusedError when it is outside the window. */
export async function ledgerEntryDay(entryDate: string): Promise<string> {
  const day = await castDay(entryDate);
  if (day === null) return entryDate;
  const reason = journalDayWindowError(day);
  if (reason) throw new JournalDateRefusedError(reason, await requestHasNotWritten());
  return day;
}
