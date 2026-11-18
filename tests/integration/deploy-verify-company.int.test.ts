// tests/integration/deploy-verify-company.int.test.ts
//
// THE DEPLOY VERIFICATION COMPANY'S DATABASE STEP, TWICE, ON THE REAL SCHEMA.
//
// scripts/deploy/verifyCompany/provisionDb.ts makes the verify user's `users` row, the company (through
// create_company_with_owner: owner membership, chart of accounts with the six system-account roles, AFS lines) and the fiscal
// years the post-deploy specs post into. It must be re-runnable on production: the second run creates and changes nothing, and
// a company it did not make is refused rather than joined or duplicated. Both are statements about rows across two runs, which
// a stubbed `pg` cannot show.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { ensureUserAndCompany, type DbOutcome } from '../../scripts/deploy/verifyCompany/provisionDb';
import { VERIFY_COMPANY_NAME, VERIFY_USER_EMAIL } from '../../scripts/deploy/verifyCompany/config';
import { readSlotReport, slotProblems } from '../../scripts/ci/golden/slotVerify';

// Only on a throwaway database: this makes a user and a company.
const describeIfDb = isDisposableDb(process.env.DATABASE_URL) ? describe : describe.skip;
const TODAY = '2026-11-18';

describeIfDb('the Deploy Verification company database step', () => {
  let pool: Pool;
  const userId = randomUUID();

  /** One transaction per run, as provision-verify-company.ts does. */
  async function run(id = userId): Promise<DbOutcome> {
    const db: PoolClient = await pool.connect();
    try {
      await db.query('BEGIN');
      const out = await ensureUserAndCompany(db, id, TODAY);
      await db.query('COMMIT');
      return out;
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      db.release();
    }
  }

  /** Every row of every table that carries company_id, for one company: the thing a re-run must not change. */
  async function footprint(companyId: string): Promise<Record<string, number>> {
    const tables = (await pool.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).rows;
    const out: Record<string, number> = {};
    for (const { table_name: t } of tables) {
      const n = Number((await pool.query(`SELECT count(*) AS n FROM public."${t}" WHERE company_id = $1::uuid`, [companyId])).rows[0].n);
      if (n) out[t] = n;
    }
    return out;
  }

  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });

  it('creates the user, a hidden internal company owned by that user, and the periods the specs post into', async () => {
    const first = await run();
    expect(first).toMatchObject({ userCreated: true, companyCreated: true });
    expect(first.periodsCreated).toBeGreaterThan(24);

    const company = (await pool.query(`SELECT name, is_demo, is_active, status, vat_number FROM companies WHERE id = $1::uuid`, [first.companyId])).rows[0];
    expect(company).toMatchObject({ name: VERIFY_COMPANY_NAME, is_demo: true, is_active: true, status: 'active' });
    expect(company.vat_number).toBeTruthy();
    const members = (await pool.query(`SELECT user_id, role, is_default FROM company_users WHERE company_id = $1::uuid`, [first.companyId])).rows;
    expect(members).toEqual([{ user_id: userId, role: 'owner', is_default: true }]);
    // The six system accounts and an open 2027-02 (the payroll sandbox month): what the suite's own precondition reads.
    const report = await readSlotReport(pool as unknown as PoolClient, first.companyId);
    expect(Object.values(report.systemAccounts).every((n) => n >= 1)).toBe(true);
    expect(report.sandboxPeriodOpen).toBe(true);
    expect(report.payrollRunsInSandboxMonth).toBe(0);
    // Only what the specs cannot make themselves is still missing: an employee and a bank account come from the seed.
    expect(slotProblems(report, false).filter((p) => !/employee|bank account/.test(p))).toEqual([]);
    const user = (await pool.query(`SELECT email, role, is_active FROM users WHERE id = $1`, [userId])).rows[0];
    expect(user).toEqual({ email: VERIFY_USER_EMAIL, role: 'accountant', is_active: true });
    const prefs = (await pool.query(`SELECT key FROM user_preferences WHERE user_id = $1 ORDER BY key`, [userId])).rows.map((r) => r.key);
    expect(prefs).toEqual(['onboarding_tour_completed', 'setup-guide-first-seen']);
  }, 120_000);

  it('a second run changes nothing that exists: same company, no new row in any company table, no new user or period', async () => {
    const companyId = (await pool.query(`SELECT company_id FROM company_users WHERE user_id = $1`, [userId])).rows[0].company_id as string;
    const before = await footprint(companyId);
    const companies = Number((await pool.query(`SELECT count(*) AS n FROM companies WHERE name = $1`, [VERIFY_COMPANY_NAME])).rows[0].n);
    const second = await run();
    expect(second).toEqual({ companyId, userCreated: false, companyCreated: false, periodsCreated: 0 });
    expect(await footprint(companyId)).toEqual(before);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM companies WHERE name = $1`, [VERIFY_COMPANY_NAME])).rows[0].n)).toBe(companies);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM users WHERE lower(email) = $1`, [VERIFY_USER_EMAIL])).rows[0].n)).toBe(1);
  }, 120_000);

  it('refuses a users row that holds the verify address under another id, rather than a second login', async () => {
    await expect(run(randomUUID())).rejects.toThrow(/under another id/);
  });

  it('refuses a company of the same name that the user is not in, instead of creating a second or joining it', async () => {
    // company_users_role_guard keeps a company's only owner: someone else becomes owner first.
    const other = randomUUID();
    const companyId = (await pool.query(`SELECT company_id FROM company_users WHERE user_id = $1`, [userId])).rows[0].company_id as string;
    await pool.query(`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ($1, $2, 'Other', 'Owner', 'accountant', true)`, [other, `other-${other}@isaflow.test`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1::uuid, $2, 'owner', true)`, [companyId, other]);
    await pool.query(`DELETE FROM company_users WHERE user_id = $1`, [userId]);
    await expect(run()).rejects.toThrow(/without the verify user as a member/);
  });
});
