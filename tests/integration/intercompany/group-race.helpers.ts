/** Shared by the group-race suites (1002's lock protocol): sessions held open, a wait seen on a lock, two writers serialised. */
import type { Pool, PoolClient } from 'pg';
import { co } from './intercompany.fixture';

export function makeRace(pool: Pool) {
  /** An open app_user transaction as withAuth opens one: the member's claims, the active company. */
  async function openSession(user: string, company: string): Promise<PoolClient> {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    return client;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const pidOf = async (c: PoolClient) => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;

  /** Wait until the backend is blocked on a lock, or polling for one (a changer sleeps between attempts) (or has already finished: then the poll gives up and the test's assertion fails). */
  async function waitsOnLock(pid: number, settled: () => boolean): Promise<boolean> {
    for (let i = 0; i < 100 && !settled(); i++) {
      const r = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND (wait_event_type = 'Lock' OR wait_event = 'PgSleep')", [pid]);
      if (r.rowCount) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  const LEAVE = 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2';
  const INSERT = `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
                  VALUES ($1, $2, 'group', 'active', $1) RETURNING id`;

  /** A second group H of A and B (so that one leave does not end the pair), removed again. */
  async function withSecondGroup<T>(fn: (h: string) => Promise<T>): Promise<T> {
    const h = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC race group H')", [h]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [h, co.A, co.B]);
    try {
      return await fn(h);
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [h]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [h]);
      await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
      await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
    }
  }

  const settle = <T>(p: Promise<T>): Promise<string> => p.then(() => 'ok', (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);
  const sharing = async () => (await pool.query('SELECT public.intercompany_shared_group($1, $2) AS ok', [co.A, co.B])).rows[0].ok as boolean;
  const connection = async (id: string) => (await pool.query('SELECT status, revoked_by FROM intercompany_connections WHERE id = $1', [id])).rows[0];

  /** An open transaction (BEGIN done, `text` run, not committed): the writer that is in flight. `user` null = the table owner. */
  async function inFlight(user: string | null, company: string, text: string, params: unknown[] = []): Promise<PoolClient> {
    const client = user ? await openSession(user, company) : await pool.connect();
    if (!user) await client.query('BEGIN');
    await client.query(text, params);
    return client;
  }

  /**
   * `first` is in flight (a transaction that has run its statement and holds what it holds); `second` then starts on `secondClient`
   * (a plain connection unless given), is seen to WAIT on a lock, and `first` commits: `second` must then complete. A deadlock
   * (40P01) shows as second's outcome. Everything is rolled back and released afterwards.
   */
  async function serialised(first: Promise<PoolClient>, second: (c: PoolClient) => Promise<unknown>, secondClient?: Promise<PoolClient>, between?: () => Promise<void>, commitSecond = false) {
    const c1 = await first;
    const c2 = secondClient ? await secondClient : await pool.connect();
    try {
      const pid = await pidOf(c2);
      let done = false;
      const run = settle(second(c2)).then((r) => { done = true; return r; });
      const waited = await waitsOnLock(pid, () => done);
      if (between) await between();
      const firstEnd = await settle(c1.query('COMMIT'));
      const secondEnd = await run;
      if (commitSecond && secondEnd === 'ok') await c2.query('COMMIT');
      return { waited, firstEnd, second: secondEnd };
    } finally {
      for (const c of [c1, c2]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  }
  const leaving = (company: string, group: string) => inFlight(null, company, LEAVE, [group, company]);
  const deactivating = (group: string) => inFlight(null, co.A, 'UPDATE company_groups SET is_active = false WHERE id = $1', [group]);
  const leave = (company: string, group: string) => (c: PoolClient) => c.query(LEAVE, [group, company]);
  const deactivate = (group: string) => (c: PoolClient) => c.query('UPDATE company_groups SET is_active = false WHERE id = $1', [group]);
  const REVOKED = { status: 'revoked', revoked_by: 'system:group-membership' };


  return {
    openSession, pidOf, waitsOnLock, LEAVE, INSERT, withSecondGroup, settle, sleep, sharing, connection, inFlight, serialised,
    leaving, deactivating, leave, deactivate, REVOKED,
  };
}
