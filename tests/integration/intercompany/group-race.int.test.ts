/**
 * Intercompany (1002): a company leaving a group while a connection is being created, re-activated or messaged on the strength
 * of the group (READ COMMITTED: the check would be stale by the time the writer commits). intercompany_in_one_group takes FOR
 * SHARE locks on the shared group's rows, so the two orders are serialised: the leave waits for the writer and then revokes
 * what it created; a writer that comes second sees the membership gone and is refused. Two real connections per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cleanup, co, pairOf, plantConnection, R, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
});

/** An open app_user transaction as withAuth opens one: the member's claims, the active company. */
async function openSession(user: string, company: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  return client;
}

const pidOf = async (c: PoolClient) => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;

/** Wait until the backend is blocked on a lock (or has already finished: then the poll gives up and the test's assertion fails). */
async function waitsOnLock(pid: number, settled: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100 && !settled(); i++) {
    const r = await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]);
    if (r.rowCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const LEAVE = 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2';
const INSERT = `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
                VALUES ($1, $2, 'group', 'active', $1) RETURNING id`;

describe('a connection being created while a company leaves', () => {
  it.each([['the high company', 1], ['the low company', 0]])('%s: the leave waits for the creating transaction, then revokes what it created (no active connection survives the group)', async (_who, index) => {
    const [low, high] = pairOf(co.A, co.B);
    const creator = await openSession(U.ab, low);
    const leaver = await pool.connect();
    try {
      const id = (await creator.query(INSERT, [low, high])).rows[0].id as string;
      const leaverPid = await pidOf(leaver);
      let done = false;
      const leaving = leaver.query(LEAVE, [co.G, [low, high][index]]).then(() => { done = true; });
      expect(await waitsOnLock(leaverPid, () => done), 'the leave is blocked by the creator\'s share lock').toBe(true);
      await creator.query('COMMIT');
      await leaving;
      const row = (await pool.query('SELECT status, revoked_by FROM intercompany_connections WHERE id = $1', [id])).rows[0];
      expect(row).toEqual({ status: 'revoked', revoked_by: 'system:group-membership' });
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
      leaver.release();
    }
  }, 30000);

  it('a creator that comes after an uncommitted leave waits, then is refused: the company has left', async () => {
    const [low, high] = pairOf(co.A, co.B);
    const leaver = await pool.connect();
    const creator = await openSession(U.ab, low);
    try {
      await leaver.query('BEGIN');
      await leaver.query(LEAVE, [co.G, co.B]);
      const creatorPid = await pidOf(creator);
      let done = false;
      const creating = creator.query(INSERT, [low, high]).then(() => 'created', (e: { message: string; code: string }) => `${e.code}: ${e.message}`).then((r) => { done = true; return r; });
      expect(await waitsOnLock(creatorPid, () => done), 'the creation is blocked by the leaver\'s row lock').toBe(true);
      await leaver.query('COMMIT');
      expect(await creating).toBe(R.needsOneGroup);
    } finally {
      await leaver.query('ROLLBACK').catch(() => undefined);
      await creator.query('ROLLBACK').catch(() => undefined);
      leaver.release();
      creator.release();
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_connections')).rows[0].n).toBe(0);
  }, 30000);
});

describe('a connection being created while its group is deleted', () => {
  it('deleting the group (is_active = false) waits for the creating transaction, then revokes what it created', async () => {
    const [low, high] = pairOf(co.A, co.B);
    const creator = await openSession(U.ab, low);
    const deleter = await pool.connect();
    try {
      const id = (await creator.query(INSERT, [low, high])).rows[0].id as string;
      const deleterPid = await pidOf(deleter);
      let done = false;
      const deleting = deleter.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]).then(() => { done = true; });
      expect(await waitsOnLock(deleterPid, () => done), 'the delete is blocked by the creator\'s share lock').toBe(true);
      await creator.query('COMMIT');
      await deleting;
      expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('revoked');
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
      deleter.release();
      await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
    }
  }, 30000);
});

describe('a message being sent while a company leaves', () => {
  it('the leave waits for the sender\'s transaction, and the connection is revoked once it commits (the message stays, on a dead connection)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const sender = await openSession(U.ab, co.A);
    const leaver = await pool.connect();
    try {
      await sender.query(
        `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
         VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')`, [id, co.A, co.B]);
      const leaverPid = await pidOf(leaver);
      let done = false;
      const leaving = leaver.query(LEAVE, [co.G, co.B]).then(() => { done = true; });
      expect(await waitsOnLock(leaverPid, () => done), 'the leave is blocked by the sender\'s share lock').toBe(true);
      await sender.query('COMMIT');
      await leaving;
      expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('revoked');
    } finally {
      await sender.query('ROLLBACK').catch(() => undefined);
      sender.release();
      leaver.release();
    }
  }, 30000);
});

describe('the locks do not get in the way', () => {
  it('two writers on the same group do not block each other (share locks), and a non-party asking takes none', async () => {
    const [low, high] = pairOf(co.A, co.B);
    const first = await openSession(U.ab, low);
    const second = await openSession(U.ab, high);
    const stranger = await openSession(U.c, co.C);
    const leaver = await pool.connect();
    try {
      for (const q of [first, second]) await q.query("SET LOCAL lock_timeout = '1500ms'");
      await stranger.query("SET LOCAL lock_timeout = '1500ms'");
      expect((await first.query('SELECT public.intercompany_in_one_group($1, $2) AS ok', [low, high])).rows[0].ok).toBe(true);
      expect((await second.query('SELECT public.intercompany_in_one_group($1, $2) AS ok', [low, high])).rows[0].ok).toBe(true);   // would wait on a FOR UPDATE
      // a leave in flight (its row lock held) does not stall someone who is no party: false at once, no lock taken
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      await leaver.query('BEGIN');
      await leaver.query(LEAVE, [co.G, co.B]);
      expect((await stranger.query('SELECT public.intercompany_in_one_group($1, $2) AS ok', [low, high])).rows[0].ok).toBe(false);
    } finally {
      await leaver.query('ROLLBACK').catch(() => undefined);
      for (const q of [first, second, stranger]) { await q.query('ROLLBACK').catch(() => undefined); q.release(); }
      leaver.release();
    }
  }, 30000);
});
