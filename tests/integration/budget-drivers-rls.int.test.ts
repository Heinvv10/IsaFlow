/**
 * Migration 949: budget_driver_lines, budget_planned_hires and budget_rolling_forecasts are
 * tenant-isolated as app_user (944's forced-RLS policy): a session working in company A neither
 * reads, writes, moves nor deletes B's rows, and cannot point an A row at B's version, centre,
 * unit or account. Real PostgreSQL; synthetic rows only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetVersionFixture } from './helpers/budgetVersionFixture';
import { driverFixture } from './helpers/budgetDriverFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const base = budgetVersionFixture(pool);
const { A, B, setup, cleanup, version, asAppUser, codeOf } = base;
const { driver, hire, rolling } = driverFixture();

let aVersion: string, bVersion: string, bReforecast: string;
const bRows: Record<string, string> = {};

beforeAll(async () => {
  await setup();
  aVersion = await version(A);
  bVersion = await version(B);
  bReforecast = await version(B, { kind: 'reforecast' });
  bRows.budget_driver_lines = (await driver(pool, B, bVersion)).rows[0].id;
  bRows.budget_planned_hires = (await hire(pool, B, bVersion)).rows[0].id;
  bRows.budget_rolling_forecasts = (await rolling(pool, B, bReforecast)).rows[0].id;
});
afterAll(async () => {
  try { await cleanup(); } finally { await pool.end(); }
});

const TABLES = ['budget_driver_lines', 'budget_planned_hires', 'budget_rolling_forecasts'] as const;

describe('949: the new budget tables are tenant-isolated as app_user', () => {
  it.each(TABLES)('%s: forced RLS with the 944 policy', async (t) => {
    const r = (await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS qual
         FROM pg_class c WHERE c.oid = $1::regclass`, [t])).rows[0];
    expect(r.relrowsecurity).toBe(true);
    expect(r.relforcerowsecurity).toBe(true);
    expect(r.qual).toContain('app.current_company_id()');
    expect(r.qual).toContain('auth.user_companies()');
  });

  it.each(TABLES)("%s: A's session sees none of B's rows and changes none", async (t) => {
    await asAppUser(A, async (q) => {
      expect((await q.query(`SELECT COUNT(*)::int n FROM ${t} WHERE id = $1`, [bRows[t]])).rows[0].n).toBe(0);
      expect((await q.query(`UPDATE ${t} SET updated_at = now() WHERE id = $1`, [bRows[t]])).rowCount).toBe(0);
      expect((await q.query(`DELETE FROM ${t} WHERE id = $1`, [bRows[t]])).rowCount).toBe(0);
    });
    expect((await pool.query(`SELECT COUNT(*)::int n FROM ${t} WHERE id = $1`, [bRows[t]])).rows[0].n).toBe(1);
  });

  it("A's session cannot insert a row carrying B's company_id", async () => {
    // The BEFORE triggers run first and, seeing none of B's rows, refuse (23514/23503); without
    // a trigger the policy's WITH CHECK refuses (42501). Either way nothing is written.
    const refused = /^(42501|23514|23503)/;
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(B, bVersion))).toMatch(refused);
      expect(await codeOf(q, ...hire.sql(B, bVersion))).toMatch(refused);
      expect(await codeOf(q, ...rolling.sql(B, bReforecast))).toMatch(refused);
    });
    const n = await pool.query(
      `SELECT (SELECT COUNT(*) FROM budget_driver_lines WHERE company_id = $1)
            + (SELECT COUNT(*) FROM budget_planned_hires WHERE company_id = $1)
            + (SELECT COUNT(*) FROM budget_rolling_forecasts WHERE company_id = $1) AS n`, [B.id]);
    expect(Number(n.rows[0].n)).toBe(3);
  });

  it("an A row cannot name B's version, centre, unit or account", async () => {
    await asAppUser(A, async (q) => {
      expect(await codeOf(q, ...driver.sql(A, bVersion))).toMatch(/^23503/);
      expect(await codeOf(q, ...hire.sql(A, bVersion))).toMatch(/^23503/);
      // The rolling check trigger finds no reforecast of A's (23514) before the FK would (23503).
      expect(await codeOf(q, ...rolling.sql(A, bReforecast))).toBe('23514');
      expect(await codeOf(q, ...driver.sql(A, aVersion, { cc1: B.cc1 }))).toMatch(/^23503/);
      expect(await codeOf(q, ...driver.sql(A, aVersion, { bu: B.bu }))).toMatch(/^23503/);
      expect(await codeOf(q, ...driver.sql(A, aVersion, { kind: 'per_head', headcountCc: B.cc1 }))).toMatch(/^23503/);
      expect(await codeOf(q, ...hire.sql(A, aVersion, { cc: B.cc1 }))).toMatch(/^23503/);
      expect(await codeOf(q, ...driver.sql(A, aVersion, { acct: B.acct }))).toBe('23514');
      expect(await codeOf(q, ...driver.sql(A, aVersion, { kind: 'pct_of_line', refAcct: B.acct }))).toBe('23514');
      // The control: A's own references are accepted.
      expect(await codeOf(q, ...driver.sql(A, aVersion, { cc1: A.cc1 }))).toBe('ok');
    });
  });
});
