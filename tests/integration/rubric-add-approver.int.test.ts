/**
 * The rubric harness's one direct write (master plan wave 4, MW, PR #1209): `insertApprover` in
 * tests/e2e/rubric/_rubricDb.ts, against the real schema. It adds the approver to the named sandbox only: never to Demo
 * (even when Demo is named), never to a company whose name is not the sandbox's, and never as the user's default company.
 * Disposable databases only; the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { insertApprover } from '../e2e/rubric/_rubricDb';
import { DEMO_COMPANY_ID } from '../e2e/rubric/_rubricGuard';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';

assertDisposableDb('the rubric approver INSERT test writes companies, users and memberships');
const describeIfDb = isDisposableDb() ? describe : describe.skip;

describeIfDb('rubric insertApprover', () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const sandbox = { id: crypto.randomUUID(), name: `0RS Rubric Sandbox it-${Date.now().toString(36)}` };
  const userId = crypto.randomUUID();
  const email = `rubric-approver-${userId}@test.local`;
  let demoName = '';
  let insertedDemo = false;

  const memberships = async (companyId: string) => (await db.query<{ role: string; is_default: boolean }>(
    'SELECT role, is_default FROM company_users WHERE company_id = $1 AND user_id = $2', [companyId, userId])).rows;

  beforeAll(async () => {
    await db.connect();
    insertedDemo = ((await db.query(
      `INSERT INTO companies (id, name, created_at) VALUES ($1, 'ISAFlow Demo', NOW()) ON CONFLICT (id) DO NOTHING`, [DEMO_COMPANY_ID])).rowCount ?? 0) > 0;
    demoName = (await db.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [DEMO_COMPANY_ID])).rows[0]!.name;
    await db.query('INSERT INTO companies (id, name, created_at) VALUES ($1, $2, NOW())', [sandbox.id, sandbox.name]);
    await db.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'accountant', true)`, [userId, email]);
  }, 60_000);

  afterAll(async () => {
    try {
      await db.query('DELETE FROM company_users WHERE user_id = $1', [userId]);
      await db.query('DELETE FROM users WHERE id = $1', [userId]);
      await db.query('DELETE FROM companies WHERE id = $1', [sandbox.id]);
      if (insertedDemo) await db.query('DELETE FROM companies WHERE id = $1', [DEMO_COMPANY_ID]);
    } finally {
      await db.end();
    }
  }, 60_000);

  it('refuses Demo, even when Demo is named by its own id and name', async () => {
    await expect(insertApprover(db, { id: DEMO_COMPANY_ID, name: demoName }, email)).rejects.toThrow(/not an owner\/admin/);
    expect(await memberships(DEMO_COMPANY_ID)).toEqual([]);
  });

  it('refuses a sandbox id whose name is not the sandbox name', async () => {
    await expect(insertApprover(db, { id: sandbox.id, name: 'ISAFlow Demo' }, email)).rejects.toThrow(/not an owner\/admin/);
    expect(await memberships(sandbox.id)).toEqual([]);
  });

  it('adds the approver to the sandbox as admin, never as their default company (they have no other)', async () => {
    expect(await insertApprover(db, sandbox, email)).toEqual({ role: 'admin', added: true });
    expect(await memberships(sandbox.id)).toEqual([{ role: 'admin', is_default: false }]);
  });

  it('is idempotent', async () => {
    expect(await insertApprover(db, sandbox, email)).toEqual({ role: 'admin', added: false });
    expect(await memberships(sandbox.id)).toHaveLength(1);
  });
});
