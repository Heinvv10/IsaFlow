/**
 * What the budget grid's services and routes share (Budgets P2 PR-B): the typed 400 for a bad
 * request, and the version token, both as Postgres prints it and as a client sends it back.
 *
 * The token is `budget_versions.updated_at` as P1's getVersion answers it: UTC ISO text with
 * microseconds ('2026-10-26T16:47:53.907461Z'), never a JS Date (which keeps milliseconds only).
 */
import { sql } from '@/lib/neon';
import { BudgetVersionError } from './budgetVersionTypes';

/** A 400 BUDGET_VERSION_INPUT; the message is shown to the caller. */
export const inputError = (message: string): BudgetVersionError => new BudgetVersionError('BUDGET_VERSION_INPUT', message);

/**
 * The token of the `budget_versions` row being selected (unqualified `updated_at`), as a `sql`
 * fragment: `SELECT ${tokenSql()} AS token FROM budget_versions WHERE …`. Built per call, not at
 * import, so a unit test's `vi.mock('@/lib/neon')` is never called while modules load.
 */
export const tokenSql = () => sql`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The token as P1 answers it (ISO, microseconds, Z) or as Postgres prints timestamptz ('… 16:47:53.907461+00'). */
const TOKEN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

const daysIn = (year: number, month: number): number =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/**
 * True when `text` is a timestamp Postgres reads as a timestamptz: the token shapes above with a
 * real calendar date and time (no 30 February, no year 0) and an offset Postgres accepts (±15:59).
 * A token that passes is compared, never trusted: a well-formed wrong one is a 409 STALE.
 */
export function isVersionToken(text: string): boolean {
  const m = TOKEN.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offH, offM] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as number[];
  return year! >= 1 && month! >= 1 && month! <= 12 && day! >= 1 && day! <= daysIn(year!, month!)
    && hour! <= 23 && minute! <= 59 && second! <= 59 && offH! <= 15 && offM! <= 59;
}
