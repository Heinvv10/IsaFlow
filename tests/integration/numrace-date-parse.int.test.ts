/**
 * Ledger-date window: the JavaScript check against Postgres's own date parse (security scan: parser differential in
 * gl/journalDateGuard). createJournalEntry checks `entryDate` in JavaScript and then hands the SAME string to
 * Postgres, so for every string the check accepts, Postgres must store exactly the day the check read — inside
 * 1900-01-01..2199-12-31. A string the check refuses and Postgres would accept is fine (a refusal); the reverse is not.
 */
import { describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { journalDateWindowError, ledgerDay } from '@/modules/accounting/utils/journalDateWindow';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';

const DATABASE_URL = process.env.DATABASE_URL;

const EDGE = [
  // whitespace, signs, years Postgres takes and the window must not
  ' 2025-03-31', '2025-03-31 ', '  03/31/2025  ', '+2025-03-31', '-2025-03-31', '2025-03-31 BC', '0044-03-15 BC',
  '100000-01-01', '10000-01-01', '100000-01-01T00:00:00', '0001-06-01', '1899-12-31', '2200-01-01',
  // special values
  'infinity', '-infinity', 'epoch', 'allballs', '2025-03-31 allballs', 'today', 'tomorrow', 'yesterday', 'now',
  'J2460000', '20250331', '2025.03.31', '31-Mar-2025',
  // times: ignored by a date cast, but only within what it accepts
  '1999-12-31 24:00', '2199-12-31 24:00', '2199-12-31 24:00:00', '2199-12-31 24:01', '2199-12-31 23:59:60',
  '2025-03-31 25:00', '2025-03-31 23:60', '2025-03-31T10:15', '2025-03-31T10:15:00.5+05:30',
  '2199-12-31T23:00:00-05:00', '1900-01-01T00:30:00+05:00', '2025-03-31Z', '2025-03-31T10:15:00 BC',
  '2025-03-31 10:15 PST',
  // the other accepted forms, and their roll-over traps
  '2025/3/31', '03/31/2025', '1/1/1900', '12/31/2199', '2/30/2025', '2025/2/30', '31/03/2025',
  'March 31, 2025', 'Mar 31 2025', '31 March 2025', 'sept 30, 2025', 'Feb 30, 2025', 'Dec 31, 2199', '31 Dec 2199 BC',
  '2026-02-29', '2024-02-29', '',
];

async function postgresDay(s: string): Promise<string | null> {
  try {
    const rows = (await sql`SELECT ${s}::date::text AS d`) as { d: string }[];
    return rows[0]!.d;
  } catch (err) {
    if (err instanceof Error && /invalid input syntax|out of range|displacement/i.test(err.message)) return null;
    throw err;
  }
}

describe.skipIf(!DATABASE_URL)('ledger-date window: no parser differential with Postgres', () => {
  it('every string the check accepts, Postgres stores as the same day, inside the window', async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const rows: Array<{ s: string; js: string | null; pg: string | null }> = [];
    for (const s of EDGE) {
      rows.push({ s, js: journalDateWindowError(s) === null ? ledgerDay(s) : null, pg: await postgresDay(s) });
    }
    process.stdout.write(`DATE-PARSE ${JSON.stringify(rows)}\n`);
    const accepted = rows.filter((r) => r.js !== null);
    for (const r of accepted) {
      expect(r.pg, `${JSON.stringify(r.s)}: Postgres stores ${r.pg}, the check read ${r.js}`).toBe(r.js);
      expect(r.pg! >= '1900-01-01' && r.pg! <= '2199-12-31', JSON.stringify(r.s)).toBe(true);
    }
    // And the window refuses every string Postgres reads outside it.
    const outside = rows.filter((r) => r.pg !== null && !/^\d{4}-\d{2}-\d{2}$/.test(r.pg) || (r.pg !== null
      && (r.pg < '1900-01-01' || r.pg > '2199-12-31')));
    expect(outside.filter((r) => r.js !== null).map((r) => r.s)).toEqual([]);
    expect(accepted.length).toBeGreaterThan(15);
  }, 60000);
});
