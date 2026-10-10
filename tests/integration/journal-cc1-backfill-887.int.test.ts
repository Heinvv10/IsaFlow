/**
 * Migration 887 — cc1_id is the only CC1 (PR #688 round 2). The whole file runs
 * against private copies of gl_journal_lines and cost_centres in a schema of
 * this file's own, each case in a rolled-back transaction (as the 883 / 886
 * precondition suites do), so no other suite's rows can change the outcome.
 *
 *  - section 0 refuses a legacy-only line whose id is not a CC1 of the line's
 *    own company (another company's, no centre at all, a CC2, an untyped one),
 *    naming at most ten lines and how many more;
 *  - section 1 copies the legacy id into cc1_id on legacy-only lines only: a
 *    re-tagged (drifted) line keeps its cc1_id, and cost_center_id is never
 *    changed.
 * The balance trigger is not on the copies; 887's header records the fixture
 * run that showed it leaves every balance as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const S = `cc1_887_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${S}`);
  await pool.query(`CREATE TABLE ${S}.cost_centres (LIKE public.cost_centres INCLUDING DEFAULTS)`);
  await pool.query(`CREATE TABLE ${S}.gl_journal_lines (LIKE public.gl_journal_lines INCLUDING DEFAULTS)`);
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
  await pool.end();
});

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../scripts/migrations/sql/887_journal_line_cc1_from_legacy_cost_centre.sql'), 'utf8');
const onCopy = MIGRATION.replaceAll('public.gl_journal_lines', `${S}.gl_journal_lines`)
  .replaceAll('public.cost_centres', `${S}.cost_centres`);

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const cc = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
const ln = (i: number) => `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`;
const [FNO, OTHER, PRJ, UNTYPED, B_FNO] = [cc(1), cc(2), cc(3), cc(4), cc(5)];

type Line = [id: string, company: string, legacy: string | null, cc1: string | null];
const seed = (lines: Line[]) => async (c: PoolClient) => {
  await c.query(`INSERT INTO ${S}.cost_centres(id, company_id, code, name, cc_type) VALUES
    ($1,$6,'FNO','FNO','cc1'), ($2,$6,'OTHER','Other','cc1'), ($3,$6,'PRJ','Project','cc2'),
    ($4,$6,'UNT','Untyped',NULL), ($5,$7,'BFNO','B FNO','cc1')`, [FNO, OTHER, PRJ, UNTYPED, B_FNO, A, B]);
  for (const [id, co, legacy, cc1] of lines) {
    await c.query(`INSERT INTO ${S}.gl_journal_lines(id, company_id, journal_entry_id, gl_account_id, debit, credit, cost_center_id, cc1_id)
                   VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 1, 0, $3, $4)`, [id, co, legacy, cc1]);
  }
};

/** The migration against the copies holding `lines`: the lines after it, or the error message. */
async function migrate(lines: Line[]): Promise<Array<Record<string, string | null>> | string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await seed(lines)(c);
    await c.query(onCopy);
    return (await c.query(`SELECT id::TEXT, cost_center_id::TEXT AS legacy, cc1_id::TEXT AS cc1
                             FROM ${S}.gl_journal_lines ORDER BY id`)).rows;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('migration 887', () => {
  it('backfills a legacy-only CC1 of the line\'s own company; a re-tagged line and the legacy column are untouched', async () => {
    expect(await migrate([
      [ln(1), A, FNO, null], [ln(2), A, FNO, OTHER], [ln(3), A, null, null], [ln(4), A, null, OTHER],
    ])).toEqual([
      { id: ln(1), legacy: FNO, cc1: FNO },
      { id: ln(2), legacy: FNO, cc1: OTHER },
      { id: ln(3), legacy: null, cc1: null },
      { id: ln(4), legacy: null, cc1: OTHER },
    ]);
  });

  it.each([
    ['another company\'s CC1', B_FNO, 'not a cost centre of this company'],
    ['no cost centre at all', cc(99), 'not a cost centre of this company'],
    ['a CC2', PRJ, 'cc_type cc2, not cc1'],
    ['an untyped centre', UNTYPED, 'cc_type NULL, not cc1'],
  ])('refuses a legacy-only line naming %s, and names it', async (_what, legacy, why) => {
    const out = await migrate([[ln(1), A, FNO, null], [ln(2), A, legacy, null]]);
    expect(out).toBe(`migration 887: 1 journal line(s) carry a legacy cost_center_id that is not a CC1 of their company — `
      + `correct each by hand before applying: ${ln(2)} (company ${A}, cost_center_id ${legacy}: ${why})`);
  });

  it('a re-tagged line is never a refusal, whatever its legacy id', async () => {
    const out = await migrate([[ln(1), A, PRJ, FNO], [ln(2), A, B_FNO, OTHER]]);
    expect(out).toEqual([{ id: ln(1), legacy: PRJ, cc1: FNO }, { id: ln(2), legacy: B_FNO, cc1: OTHER }]);
  });

  it('names the first ten and counts the rest', async () => {
    const out = await migrate(Array.from({ length: 12 }, (_, i): Line => [ln(i + 1), A, cc(100 + i), null]));
    expect(out).toMatch(/^migration 887: 12 journal line\(s\) /);
    expect(out).toContain(ln(10));
    expect(out).not.toContain(ln(11));
    expect(out).toMatch(/ \(\+2 more\)$/);
  });
});
