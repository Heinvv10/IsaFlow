/**
 * Wave 3 K1, the service pool and the bank details history. entity_changes keeps the account number in full (a reveal
 * needs it) and app_service's mirror on it is USING (true), so 952 adds a restrictive policy binding app_service
 * sessions: with no claims at all they read no payroll_bank_detail row, and every other type as before. A re-sync of
 * the mirrors keeps it, 915's drift check does not report it, and a request's own history read is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { employee, put, ROW } from './k1-employee-bank-details.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', A = '';

beforeAll(async () => {
  [o] = await members(pool, tokens, 1);
  A = await newCompany(pool, [[o, 'owner']], companies);
  expect((await put(tokens[o]!, A, await employee(pool, A), ROW)).state.statusCode).toBe(200);
});
afterAll(() => cleanupEntityChanges(pool, companies, [o]));

/** `fn` as `role` with no claims and no company, after `setup` as the owner; rolled back. */
async function claimless<T>(role: string, fn: (db: PoolClient) => Promise<T>, setup?: string): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (setup) await db.query(setup);
    await db.query(`SET LOCAL ROLE ${role}`);
    return await fn(db);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
}

const counts = async (db: PoolClient) => (await db.query<{ bank: number; other: number; numbers: number }>(`SELECT
    count(*) FILTER (WHERE entity_type = 'payroll_bank_detail')::int AS bank,
    count(*) FILTER (WHERE entity_type <> 'payroll_bank_detail' AND company_id = $1)::int AS other,
    count(*) FILTER (WHERE "after"::text LIKE '%' || $2 || '%' OR "before"::text LIKE '%' || $2 || '%')::int AS numbers
  FROM entity_changes`, [A, ROW.accountNumber])).rows[0]!;

describe('a claimless service-pool session', () => {
  it('the history holds the row, read as its owner', async () => {
    const { rows } = await pool.query(
      "SELECT 1 FROM entity_changes WHERE entity_type = 'payroll_bank_detail' AND company_id = $1", [A]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(['app_service', 'isaflow_service'])('as %s: no payroll_bank_detail row, no number, and the other types still', async (role) => {
    const seen = await claimless(role, counts);
    expect(seen).toMatchObject({ bank: 0, numbers: 0 });
    expect(seen.other).toBeGreaterThan(0);
  });

  it('after a re-sync of app_service\'s mirrors, the same', async () => {
    const seen = await claimless('app_service', counts, 'SELECT public.app_service_sync_policies()');
    expect(seen).toMatchObject({ bank: 0, numbers: 0 });
    expect(seen.other).toBeGreaterThan(0);
  });

  it('915\'s drift check and the deploy\'s violations list report nothing on entity_changes', async () => {
    const drift = await pool.query("SELECT why, what FROM public.app_service_policy_drift() WHERE tbl = 'public.entity_changes'::regclass");
    expect(drift.rows).toEqual([]);
    const v = await pool.query("SELECT v FROM public.app_login_role_violations(false) v WHERE v LIKE '%entity_changes%'");
    expect(v.rows).toEqual([]);
  });

  it('a request (app_user, the owner\'s own claims) still reads its own bank history', async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: o, session_id: crypto.randomUUID() })]);
      await db.query("SELECT set_config('app.current_company_id', $1, true)", [A]);
      await db.query('SET LOCAL ROLE app_user');
      const { rows } = await db.query("SELECT 1 FROM entity_changes WHERE entity_type = 'payroll_bank_detail'");
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });
});
