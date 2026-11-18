/** Sessions for the intercompany (999z) suites: app_user as withAuth opens one, the table owner, and the exact refusal of a statement. */
import type { Pool, PoolClient } from 'pg';

async function open(pool: Pool, user: string | null, company: string, role: 'app_user' | null): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  if (role) await client.query(`SET LOCAL ROLE ${role}`);
  if (user) await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  return client;
}

async function run<T>(client: PoolClient, fn: (q: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  try {
    const out = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A session as withAuth opens one (app_user, the member's claims, the active company). Rolled back unless `commit`. */
export async function asAppUser<T>(pool: Pool, user: string, company: string, fn: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
  return run(await open(pool, user, company, 'app_user'), fn, commit);
}

/**
 * The same claims on the table OWNER's privileges (postgres, a superuser here): no column grant and no RLS stands
 * between a statement and the trigger, so a test sees the trigger's own refusal. `user` null = no session user.
 */
export async function asOwner<T>(pool: Pool, user: string | null, company: string, fn: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
  return run(await open(pool, user, company, null), fn, commit);
}

/** 'ok', or `<SQLSTATE>: <message>` of the refusal. Runs in a savepoint so the session stays usable. */
export async function outcome(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await q.query('SAVEPOINT ic_probe');
  try {
    await q.query(text, params);
    await q.query('RELEASE SAVEPOINT ic_probe');
    return 'ok';
  } catch (err) {
    await q.query('ROLLBACK TO SAVEPOINT ic_probe');
    const e = err as { code?: string; message?: string };
    return `${e.code}: ${e.message}`;
  }
}

export const count = async (q: Pool | PoolClient, text: string, params: unknown[] = []): Promise<number> =>
  Number((await q.query(text, params)).rows[0].n);

/** The pair in the table's order. */
export const pairOf = (x: string, y: string) => (x.toLowerCase() < y.toLowerCase() ? [x, y] : [y, x]) as [string, string];


/** Run `fn` with one trigger of `table` disabled for the transaction (a superuser's DDL; it is back on at COMMIT). */
export async function withoutTrigger<T>(pool: Pool, table: string, trigger: string, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const out = await fn(client);
    await client.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

