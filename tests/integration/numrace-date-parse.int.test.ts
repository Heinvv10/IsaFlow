/**
 * Ledger-date window: the day checked is the day stored (brk-numrace F1, sec-numrace DateStyle note). Every DB-backed
 * path reads a tenant's date with Postgres (gl/journalDateGuard: `::date`, as its INSERT would), checks the window on
 * that day, and stores it. So:
 *   - every form base accepted still reads as its day (brk's list: 20250331, 2025-3-31, 31-Mar-2025, 2025.03.31,
 *     03-31-2025, 3/31/25, "Monday, March 31, 2025", …);
 *   - every string Postgres reads outside 1900..2199 (5- and 6-digit years, BC, ±infinity, 0001, 2200) is refused;
 *   - a string Postgres cannot read is handed back (null day) to fail as it did before, inside a request too (the
 *     batch's failure falls back to one savepoint per string; the transaction stays usable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { ledgerDaysOf, ledgerEntryDay } from '@/modules/accounting/services/gl/journalDateGuard';
import { isJournalDateRefused, journalDayWindowError } from '@/modules/accounting/utils/journalDateWindow';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
let c: DateFixture;

const BASE_FORMS = ['2025-03-31', '2025-3-31', '31-Mar-2025', '2025.03.31', '03-31-2025', 'Mar 31 2025', '31 Mar 2025',
  '2025/3/31', '3/31/2025', '3/31/25', '20250331', '2025-03-31T10:00:00.000Z', 'Monday, March 31, 2025',
  ' 2025-03-31 ', '2025-03-31 24:00', '2025-03-31T23:00:00-05:00', 'March 31, 2025'];
const OUTSIDE = ['100000-01-01', '10000-01-01', '100000-01-01T00:00:00', '2025-03-31 BC', '0044-03-15 BC', 'infinity',
  '-infinity', '0001-06-01', '1899-12-31', '2200-01-01', '2199-12-31 BC', 'Dec 31, 2200'];
const UNREADABLE = ['allballs', '2/30/2025', '2025-03-31 25:00', '+2025-03-31', 'not a date', ''];

async function postgresDay(s: string): Promise<string | null> {
  try {
    return ((await sql`SELECT ${s}::date::text AS d`) as { d: string }[])[0]!.d;
  } catch (err) {
    if (String((err as { code?: string }).code ?? '').startsWith('22')) return null;
    throw err;
  }
}

describe.skipIf(!DATABASE_URL)('ledger-date window: Postgres reads the date', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-DP', DATABASE_URL!);
  }, 60000);
  afterAll(async () => { await dropFixture(c.fx); }, 60000);

  it('ledgerDaysOf is exactly ::date (null where it cannot cast), inside a request transaction', async () => {
    const all = [...BASE_FORMS, ...OUTSIDE, ...UNREADABLE];
    const days = await inTx(c.fx, async () => {
      const d = await ledgerDaysOf(all);
      await sql`SELECT 1`; // the request transaction is still usable after the per-string fallback
      return d;
    });
    const rows = [];
    for (const s of all) rows.push({ s, mine: days.get(s) ?? null, pg: await postgresDay(s) });
    process.stdout.write(`DATE-PARSE ${JSON.stringify(rows)}\n`);
    for (const r of rows) expect(r.mine, JSON.stringify(r.s)).toBe(r.pg);
  }, 60000);

  it("brk F1: every form base accepted reads as 2025-03-31 and passes the window", async () => {
    const days = await ledgerDaysOf(BASE_FORMS);
    for (const s of BASE_FORMS) {
      expect(days.get(s), JSON.stringify(s)).toBe('2025-03-31');
      expect(journalDayWindowError(days.get(s)!), JSON.stringify(s)).toBeNull();
    }
  }, 60000);

  it('every string Postgres reads outside 1900..2199 is refused; an unreadable one is handed back unchanged', async () => {
    for (const s of OUTSIDE) {
      let err: unknown = null;
      try { await inTx(c.fx, () => ledgerEntryDay(s)); } catch (e) { err = e; }
      expect(isJournalDateRefused(err), `${JSON.stringify(s)}: ${String(err)}`).toBe(true);
    }
    for (const s of UNREADABLE) expect(await inTx(c.fx, () => ledgerEntryDay(s))).toBe(s);
    expect(await inTx(c.fx, () => ledgerEntryDay('Monday, March 31, 2025'))).toBe('2025-03-31');
  }, 60000);
});
