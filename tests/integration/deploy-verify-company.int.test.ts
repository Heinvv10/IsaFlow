// tests/integration/deploy-verify-company.int.test.ts
//
// THE DEPLOY VERIFICATION COMPANY'S DATABASE STEP AND ITS BLOCKS' QUERIES, ON THE REAL SCHEMA.
//
// scripts/deploy/verifyCompany/provisionDb.ts makes the two users' `users` rows, the company (through create_company_with_owner:
// owner membership, chart of accounts with the six system-account roles, AFS lines), the approver's admin membership and the
// fiscal years. It must be re-runnable on production (the second run creates and changes nothing), race-free (two runs at once
// never make two companies) and refuse a company it did not make. Every block's SQL (seedBlocks.ts) is executed here against the
// real columns, and finds a record carrying the marker the seeders write. Each test builds its own users and sets the previous
// tests' company aside, so none depends on another.
//
// ci-integration-skip: skips when DATABASE_URL is not a disposable local database (isDisposableDb); the integration gate runs it on one.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { ensureUserAndCompany, type DbOutcome, type UserIds } from '../../scripts/deploy/verifyCompany/provisionDb';
import { APPROVER_LOGIN, APPROVER_ROLE, VERIFY_COMPANY_NAME, VERIFY_LOGIN } from '../../scripts/deploy/verifyCompany/identity';
import { releaseRunLock, tryRunLock } from '../../scripts/deploy/verifyCompany/lock';
import { buildBlocks } from '../../scripts/deploy/verifyCompany/seedBlocks';
import { companyProblems } from '../../scripts/deploy/verifyCompany/readiness';
import { readSlotReport } from '../../scripts/ci/golden/slotVerify';

// Only on a throwaway database: this makes users and companies.
const describeIfDb = isDisposableDb(process.env.DATABASE_URL) ? describe : describe.skip;
const TODAY = new Date('2026-11-18T10:00:00Z');

describeIfDb('the Deploy Verification company database step', () => {
  let pool: Pool;
  let ids: UserIds;

  /** One transaction per run, as run.ts does it. */
  async function run(userIds: UserIds = ids, client?: PoolClient, today: Date = TODAY): Promise<DbOutcome> {
    const db = client ?? await pool.connect();
    try {
      await db.query('BEGIN');
      const out = await ensureUserAndCompany(db, userIds, today);
      await db.query('COMMIT');
      return out;
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    } finally {
      if (!client) db.release();
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

  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    // Independent tests: new users, and any company an earlier test (or run) made is renamed out of the way.
    ids = { verify: randomUUID(), approver: randomUUID() };
    await pool.query(`UPDATE companies SET name = name || ' (earlier ' || id::text || ')' WHERE name = $1`, [VERIFY_COMPANY_NAME]);
    await pool.query(`DELETE FROM users WHERE lower(email) = ANY($1::text[])`, [[VERIFY_LOGIN.email, APPROVER_LOGIN.email]]).catch(() => undefined);
    await pool.query(`UPDATE users SET email = 'old-' || id::text || '@isaflow.test' WHERE lower(email) = ANY($1::text[])`, [[VERIFY_LOGIN.email, APPROVER_LOGIN.email]]);
  });

  it('creates both users, a hidden internal company owned by the verify user with the approver an admin, and the periods the specs post into', async () => {
    const first = await run();
    expect(first).toMatchObject({ userCreated: true, approverCreated: true, companyCreated: true, approverJoined: true });
    expect(first.periodsCreated).toBeGreaterThan(24);

    const company = (await pool.query(`SELECT name, is_demo, is_active, status, vat_number FROM companies WHERE id = $1::uuid`, [first.companyId])).rows[0];
    expect(company).toMatchObject({ name: VERIFY_COMPANY_NAME, is_demo: true, is_active: true, status: 'active' });
    expect(company.vat_number).toBeTruthy();
    const members = (await pool.query(`SELECT user_id, role, is_default FROM company_users WHERE company_id = $1::uuid ORDER BY role`, [first.companyId])).rows;
    expect(members).toEqual([
      { user_id: ids.approver, role: APPROVER_ROLE, is_default: true },
      { user_id: ids.verify, role: 'owner', is_default: true },
    ]);
    // The six system accounts and an open 2027-02 (the payroll sandbox month): what the suite's own precondition reads.
    const report = await readSlotReport(pool as unknown as PoolClient, first.companyId);
    expect(Object.values(report.systemAccounts).every((n) => n >= 1)).toBe(true);
    expect(report.sandboxPeriodOpen).toBe(true);
    expect(report.payrollRunsInSandboxMonth).toBe(0);
    // Only what the app seeds is still missing.
    expect((await companyProblems(pool as unknown as PoolClient, first.companyId, ids)).filter((p) => !/employee|bank account/.test(p))).toEqual([]);
    const users = (await pool.query(`SELECT id, email, role, is_active FROM users WHERE id = ANY($1::text[]) ORDER BY email`, [[ids.verify, ids.approver]])).rows;
    expect(users.map((u) => u.email)).toEqual([APPROVER_LOGIN.email, VERIFY_LOGIN.email]);
    expect(users.every((u) => u.is_active && u.role === 'accountant')).toBe(true);
    const prefs = (await pool.query(`SELECT key FROM user_preferences WHERE user_id = $1 ORDER BY key`, [ids.verify])).rows.map((r) => r.key);
    expect(prefs).toEqual(['onboarding_tour_completed', 'setup-guide-first-seen']);
  }, 120_000);

  it('the company gets periods for the previous, current and next financial year of the run date, whichever month that is', async () => {
    const feb = await run(ids, undefined, new Date('2027-02-10T10:00:00Z')); // FY2027 ends this month: the previous year is FY2026
    const years = (await pool.query(`SELECT fiscal_year FROM fiscal_years WHERE company_id = $1::uuid ORDER BY fiscal_year`, [feb.companyId])).rows.map((r) => Number(r.fiscal_year));
    expect(years).toEqual(expect.arrayContaining([2026, 2027, 2028]));
  }, 120_000);

  it('a second run changes nothing that exists: same company, no new row in any company table, no new user, membership or period', async () => {
    const first = await run();
    const before = await footprint(first.companyId);
    const named = Number((await pool.query(`SELECT count(*) AS n FROM companies WHERE name = $1`, [VERIFY_COMPANY_NAME])).rows[0].n);
    const second = await run();
    expect(second).toEqual({ companyId: first.companyId, userCreated: false, approverCreated: false, companyCreated: false, approverJoined: false, periodsCreated: 0 });
    expect(await footprint(first.companyId)).toEqual(before);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM companies WHERE name = $1`, [VERIFY_COMPANY_NAME])).rows[0].n)).toBe(named);
  }, 120_000);

  it('two runs at once make ONE company: the second waits for the first transaction, then finds its company', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      const firstOut = await ensureUserAndCompany(a, ids, TODAY); // not committed yet: invisible to b
      await b.query('BEGIN');
      let bDone = false;
      const second = ensureUserAndCompany(b, ids, TODAY).then((o) => { bDone = true; return o; });
      await new Promise((r) => setTimeout(r, 500));
      expect(bDone, 'the second run must be waiting on the first one\'s transaction lock').toBe(false);
      await a.query('COMMIT');
      const secondOut = await second;
      await b.query('COMMIT');
      expect(firstOut.companyCreated).toBe(true);
      expect(secondOut).toMatchObject({ companyId: firstOut.companyId, companyCreated: false, userCreated: false, approverCreated: false, approverJoined: false });
      expect(Number((await pool.query(`SELECT count(*) AS n FROM companies WHERE name = $1`, [VERIFY_COMPANY_NAME])).rows[0].n)).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 120_000);

  it('the run lock is held by one connection at a time and free again once released', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      expect(await tryRunLock(a)).toBe(true);
      expect(await tryRunLock(b)).toBe(false);
      await releaseRunLock(a);
      expect(await tryRunLock(b)).toBe(true);
      await releaseRunLock(b);
    } finally {
      a.release();
      b.release();
    }
  });

  it('refuses a users row that holds the verify address under another id, rather than a second login', async () => {
    await run();
    await expect(run({ verify: randomUUID(), approver: ids.approver })).rejects.toThrow(/under another id/);
  });

  it('refuses a company of the same name that the user is not in, instead of creating a second or joining it', async () => {
    const made = await run();
    // company_users_role_guard keeps a company's only owner: someone else becomes owner first.
    const other = randomUUID();
    await pool.query(`INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES ($1, $2, 'Other', 'Owner', 'accountant', true)`, [other, `other-${other}@isaflow.test`]);
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1::uuid, $2, 'owner', true)`, [made.companyId, other]);
    await pool.query(`DELETE FROM company_users WHERE user_id = $1`, [ids.verify]);
    await expect(run()).rejects.toThrow(/without the verify user as a member/);
  });

  describe('the blocks\' SQL, against the real columns', () => {
    const ctx = async () => {
      const made = await run();
      return { db: pool as unknown as PoolClient, companyId: made.companyId, verifyUserId: ids.verify, now: TODAY };
    };

    it('every block plans on an empty company: incomplete, with no SQL error', async () => {
      const c = await ctx();
      for (const b of buildBlocks()) expect(await b.plan(c).then((p) => [b.name, p.complete])).toEqual([b.name, false]);
    }, 120_000);

    it('finds a record by the marker the seeders write: a customer and a supplier by index, a prior-year journal, a cost-of-sales account, a budget year', async () => {
      const c = await ctx();
      await pool.query(`INSERT INTO customers (company_id, name) VALUES ($1::uuid, 'Demo Customer 1'), ($1::uuid, 'Demo Customer 2'), ($1::uuid, 'Demo Customer 2 extra')`, [c.companyId]);
      await pool.query(`INSERT INTO suppliers (company_id, name) VALUES ($1::uuid, '0GP-Golden-Supplier')`, [c.companyId]);
      await pool.query(
        `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance) VALUES ($1::uuid, '5150', 'Cost of Sales', 'expense', 'cost_of_sales', 'debit')`, [c.companyId]);
      await pool.query(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, created_by) VALUES ($1::uuid, 2027, 'x', 'original', $2)`, [c.companyId, ids.verify]);
      const plans = Object.fromEntries(await Promise.all(buildBlocks().map(async (b) => [b.name, (await b.plan(c)).complete] as const)));
      expect(plans['fixture supplier']).toBe(true);
      expect(plans['cost of sales account']).toBe(true);
      expect(plans['budget original version, current year']).toBe(true); // FY2027 holds 2026-11-18
      expect(plans['budget original version, next year']).toBe(false); // keyed by the year, not the name
      expect(plans.customers).toBe(false); // 2 of 4 (and the look-alike "Demo Customer 2 extra" is not a marker): resumable, not complete
    }, 120_000);

    it('the migration sandbox is complete only when the verify user is in it AND it is is_demo', async () => {
      const c = await ctx();
      const sandbox = (await buildBlocks().find((b) => b.name === 'migration sandbox company')!.plan(c));
      expect(sandbox.complete).toBe(false);
      const made = await pool.query<{ id: string }>(`INSERT INTO companies (name, is_demo) VALUES ('0GP Golden Migration Sandbox', false) RETURNING id::text AS id`);
      await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1::uuid, $2, 'owner', false)`, [made.rows[0]!.id, ids.verify]);
      const block = buildBlocks().find((b) => b.name === 'migration sandbox company')!;
      expect((await block.plan(c)).complete).toBe(false); // exists, not is_demo
      await pool.query(`UPDATE companies SET is_demo = true WHERE id = $1::uuid`, [made.rows[0]!.id]);
      expect((await block.plan(c)).complete).toBe(true);
    }, 120_000);
  });
});
