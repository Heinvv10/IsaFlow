/**
 * Wave 3 K1, the service pool and the bank details history. entity_changes keeps the account number in full (a reveal
 * needs it). 952 puts entity_changes on 915's exclusion list beside payroll_bank_details, so app_service has no SELECT
 * mirror on it: a claimless service-pool session reads no row of it at all, however it switches role mid-query (a
 * mirror's USING (true) is fixed when the query is planned). Every reader of the history (the routes, MCP, audit
 * snapshots and comparisons through runAuditTx) switches to app_user with the caller's claims first, and still reads.
 * The superuser fixture session stands in for the isaflow_service login: RLS judges current_user, not the session user.
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

const BANK = "SELECT company_id, \"after\"->>'account_number' AS n FROM entity_changes WHERE entity_type = 'payroll_bank_detail'";

describe('a claimless service-pool session', () => {
  it('the history holds the row, read as its owner', async () => {
    const { rows } = await pool.query(`${BANK} AND company_id = $1`, [A]);
    expect(rows.map((r) => r.n)).toContain(ROW.accountNumber);
  });

  it.each(['app_service', 'isaflow_service'])('as %s: no row of the history at all', async (role) => {
    expect(await claimless(role, counts)).toEqual({ bank: 0, other: 0, numbers: 0 });
  });

  it('after a re-sync of app_service\'s mirrors, the same: the sync makes none for entity_changes', async () => {
    expect(await claimless('app_service', counts, 'SELECT public.app_service_sync_policies()')).toEqual({ bank: 0, other: 0, numbers: 0 });
    const { rows } = await pool.query(
      "SELECT polname FROM pg_policy WHERE polrelid = 'entity_changes'::regclass AND 'app_service'::regrole = ANY (polroles)");
    expect(rows).toEqual([]);
  });

  it('the switch the next two cases make is one app_service may make (PG 16: the membership\'s SET option)', async () => {
    const { rows } = await pool.query("SELECT pg_has_role('app_service', 'app_user', 'SET') AS can_set");
    expect(rows).toEqual([{ can_set: true }]);
  });

  it('a cursor opened as app_service and fetched after SET ROLE app_user reads no bank row', async () => {
    const fetched = await claimless('app_service', async (db) => {
      await db.query(`DECLARE c CURSOR FOR ${BANK}`);
      await db.query('SET LOCAL ROLE app_user');
      return (await db.query('FETCH ALL FROM c')).rows;
    });
    expect(fetched).toEqual([]);
  });

  it('a query that switches to app_user mid-scan reads no bank row', async () => {
    const rows = await claimless('app_service', async (db) =>
      (await db.query(`${BANK} AND set_config('role', 'app_user', true) IS NOT NULL`)).rows);
    expect(rows).toEqual([]);
  });

  it('915\'s drift check and the deploy\'s violations list report nothing on entity_changes', async () => {
    const drift = await pool.query("SELECT why, what FROM public.app_service_policy_drift() WHERE tbl = 'public.entity_changes'::regclass");
    expect(drift.rows).toEqual([]);
    const v = await pool.query("SELECT v FROM public.app_login_role_violations(false) v WHERE v LIKE '%entity_changes%'");
    expect(v.rows).toEqual([]);
  });

  it('a reader as runAuditTx runs it (the service login, then app_user with the owner\'s claims) reads its history', async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE isaflow_service');
      await db.query('SET LOCAL ROLE app_user');
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: o, session_id: crypto.randomUUID() })]);
      await db.query("SELECT set_config('app.current_company_id', $1, true)", [A]);
      const seen = await counts(db);
      expect(seen.bank).toBeGreaterThan(0);
      expect(seen.other).toBeGreaterThan(0);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });
});
