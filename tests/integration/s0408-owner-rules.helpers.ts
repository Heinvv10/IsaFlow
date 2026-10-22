// Helpers for the migration 909 owner-rule suites (audit S-04/S-08 follow-ups
// A and B): companies and members seeded as the (superuser) test pool, writes
// made as the real roles inside their own transactions.

import type { Pool, PoolClient } from 'pg';

export type Role = 'app_user' | 'platform_admin' | 'migration_admin';

export interface Tx {
  client: PoolClient;
  pid: number;
  q: (text: string, params?: unknown[]) => Promise<unknown>;
  end: (commit: boolean) => Promise<void>;
}

/**
 * Open a transaction as `role` (app_user under `sub`'s claims, as withAuth
 * sets them). `isolation` defaults to READ COMMITTED, the app's level.
 */
export async function openTx(pool: Pool, role: Role, companyId: string, sub?: string,
  isolation = 'READ COMMITTED'): Promise<Tx> {
  const client = await pool.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await client.query(`SET LOCAL ROLE ${role}`);
  if (sub) {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub, role: 'authenticated', session_id: crypto.randomUUID() })]);
  }
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
  const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  let done = false;
  return {
    client, pid,
    q: (text, params) => client.query(text, params as unknown[]),
    end: async (commit) => {
      if (done) return;
      done = true;
      try { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); } finally { client.release(); }
    },
  };
}

/** Run one statement as `role` in its own transaction, committed if it succeeds. */
export async function asRole(pool: Pool, role: Role, companyId: string, sql: string, params: unknown[],
  sub?: string, isolation?: string): Promise<void> {
  const tx = await openTx(pool, role, companyId, sub, isolation);
  try {
    await tx.q(sql, params);
    await tx.end(true);
  } catch (err) {
    await tx.end(false);
    throw err;
  }
}

/** 'ok', or the SQLSTATE (or message) a promise rejected with. */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return String((err as { code?: unknown }).code ?? (err as Error).message);
  }
}

/** Resolve once backend `pid` waits on a lock (`event`: 'advisory', 'tuple', 'transactionid', …). */
export async function waitsOnLock(pool: Pool, pid: number, event?: string): Promise<void> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const r = await pool.query('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
    const row = r.rows[0] as { wait_event_type: string | null; wait_event: string | null } | undefined;
    if (row?.wait_event_type === 'Lock' && (!event || row.wait_event === event)) return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`backend ${pid} never waited on a ${event ?? ''} lock`);
}

/** A company with `members` ([user, role]); ids are pushed to `companies` for cleanup. */
export async function seedCompany(pool: Pool, companies: string[], members: [string, string][]): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [id, `909 ${id.slice(0, 8)}`]);
  companies.push(id);
  for (const [user, role] of members) {
    await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, $3)', [id, user, role]);
  }
  return id;
}

export const roleOf = async (pool: Pool, c: string, user: string): Promise<string | null> => ((await pool.query(
  'SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [c, user])).rows[0]?.role ?? null) as string | null;

export const ownersOf = async (pool: Pool, c: string): Promise<string[]> => (await pool.query(
  "SELECT user_id FROM company_users WHERE company_id = $1 AND role = 'owner' ORDER BY user_id", [c])).rows.map((r) => r.user_id as string);

/** The test pool is a superuser, which the last-owner rule outside app_user exempts. */
export async function cleanup(pool: Pool, companies: string[]): Promise<void> {
  if (companies.length === 0) return;
  await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
}

export const ownerLockKey = (c: string) => `company_owners:${c}`;
