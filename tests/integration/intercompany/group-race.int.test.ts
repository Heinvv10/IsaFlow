/**
 * Intercompany (1002): a company leaving a group while a connection is being created, re-activated or messaged on the strength
 * of the group (READ COMMITTED: the check would be stale by the time the writer commits), and two membership changes at the same
 * moment (each sees the other's change uncommitted). One lock protocol (1002 header): deciders take the topology advisory lock
 * SHARED (intercompany_in_one_group), changers take it EXCLUSIVE (the revoking trigger), after locking the candidate sides' rows.
 * So every pair of orders is serialised: the changer waits for the writer and then revokes what it created; a writer that comes
 * second sees the change and is refused; two changers serialise, the second sees the first. No 40P01 in any of them.
 * Two real connections per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { companies } from './intercompany.fixture';
import { asAppUser, cleanup, co, pairOf, plantConnection, plantMessage, plantSide, R, setup, U, wipeConnections } from './intercompany.helpers';

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
async function serialised(first: Promise<PoolClient>, second: (c: PoolClient) => Promise<unknown>, secondClient?: Promise<PoolClient>, between?: () => Promise<void>) {
  const c1 = await first;
  const c2 = secondClient ? await secondClient : await pool.connect();
  try {
    const pid = await pidOf(c2);
    let done = false;
    const run = settle(second(c2)).then((r) => { done = true; return r; });
    const waited = await waitsOnLock(pid, () => done);
    if (between) await between();
    const firstEnd = await settle(c1.query('COMMIT'));
    return { waited, firstEnd, second: await run };
  } finally {
    for (const c of [c1, c2]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }
}
const leaving = (company: string, group: string) => inFlight(null, company, LEAVE, [group, company]);
const deactivating = (group: string) => inFlight(null, co.A, 'UPDATE company_groups SET is_active = false WHERE id = $1', [group]);
const leave = (company: string, group: string) => (c: PoolClient) => c.query(LEAVE, [group, company]);
const deactivate = (group: string) => (c: PoolClient) => c.query('UPDATE company_groups SET is_active = false WHERE id = $1', [group]);
const REVOKED = { status: 'revoked', revoked_by: 'system:group-membership' };

describe('two membership changes at the same moment (write skew)', () => {
  it.each([['A leaves H, then B leaves G', 0], ['B leaves G, then A leaves H', 1]])(
    'concurrent double leave, no shared group left: %s: the second waits, then both are done and the connection is revoked', async (_label, which) => {
      await withSecondGroup(async (h) => {
        const id = await plantConnection(pool, co.A, co.B);
        const steps: Array<[string, string]> = [[co.A, h], [co.B, co.G]];
        const [x, y] = which === 0 ? steps : [steps[1], steps[0]];
        const r = await serialised(leaving(x[0], x[1]), leave(y[0], y[1]));
        expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
        expect(await sharing()).toBe(false);
        expect(await connection(id)).toEqual(REVOKED);
      });
    }, 30000);

  it('control: the same two leaves one after the other revoke too', async () => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      await pool.query(LEAVE, [h, co.A]);
      expect((await connection(id)).status).toBe('active');
      await pool.query(LEAVE, [co.G, co.B]);
      expect((await connection(id)).status).toBe('revoked');
    });
  }, 30000);

  it('two leaves that leave a shared group behind revoke nothing (the lock does not over-revoke)', async () => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      const r = await serialised(leaving(co.A, h), leave(co.B, h));
      expect(r.second).toBe('ok');
      expect(await sharing()).toBe(true);                       // both still share G
      expect((await connection(id)).status).toBe('active');
    });
  }, 30000);

  it.each([['H then G', 0], ['G then H', 1]])('concurrent double group deactivation (%s): the second waits, then the connection is revoked', async (_label, which) => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      const [x, y] = which === 0 ? [h, co.G] : [co.G, h];
      const r = await serialised(deactivating(x), deactivate(y));
      expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
      expect(await sharing()).toBe(false);
      expect(await connection(id)).toEqual(REVOKED);
    });
  }, 30000);

  it.each([['the leave first', true], ['the deactivation first', false]])('a leave and a group deactivation at the same moment: %s', async (_label, leaveFirst) => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      const r = leaveFirst ? await serialised(leaving(co.B, co.G), deactivate(h)) : await serialised(deactivating(h), leave(co.B, co.G));
      expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
      expect(await connection(id)).toEqual(REVOKED);
    });
  }, 30000);
});

describe('a group deactivation that has to wait', () => {
  it('re-reads the members once it holds the lock: companies that joined the group meanwhile, and the connection they made, are revoked too', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.A, co.B, {}, U.a);
    const extra: string[] = [];
    for (const name of ['X1', 'X2']) {
      const c = crypto.randomUUID();
      await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [c, `IC race ${name} ${c.slice(0, 6)}`]);
      await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [c, U.ac]);
      extra.push(c);
      companies.push(c);
    }
    let late = '';
    try {
      // the deactivation reads {A, B}, then waits for A's side row, which a writer holds
      const r = await serialised(
        inFlight(U.a, co.A, 'UPDATE intercompany_connection_sides SET auto_accept = auto_accept WHERE connection_id = $1 AND company_id = $2', [id, co.A]),
        deactivate(co.G), undefined,
        async () => {
          await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [co.G, extra[0], extra[1]]);
          late = await plantConnection(pool, extra[0], extra[1], U.ac);
        });
      expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
      expect(await connection(id)).toEqual(REVOKED);
      expect(await connection(late)).toEqual(REVOKED);
    } finally {
      await pool.query('DELETE FROM intercompany_connection_sides WHERE connection_id = $1', [late || id]);
      await pool.query('DELETE FROM intercompany_connections WHERE id = $1', [late || id]);
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = ANY($2)', [co.G, extra]);
      await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
    }
  }, 30000);
});

describe('a re-activation and a leave at the same moment', () => {
  const revoked = async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    return id;
  };
  const REACTIVATE = "UPDATE intercompany_connections SET status = 'active' WHERE id = $1";

  it('the re-activation holds its row and the lock first: the leave waits (no deadlock), then revokes it again', async () => {
    const id = await revoked();
    const r = await serialised(inFlight(U.ab, co.A, REACTIVATE, [id]), leave(co.B, co.G));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect(await connection(id)).toEqual(REVOKED);
  }, 30000);

  it('the leave comes first: the re-activation waits for it, then is refused (no group left)', async () => {
    const id = await revoked();
    const r = await serialised(leaving(co.B, co.G), (c) => c.query(REACTIVATE, [id]), openSession(U.ab, co.A));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: R.needsOneGroup });
    expect((await connection(id)).status).toBe('revoked');
  }, 30000);
});

describe('switching auto-accept on and a leave at the same moment', () => {
  const side = async (id: string) => (await pool.query('SELECT auto_accept FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.B])).rows[0];
  const ON = 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2';

  it('the side update holds its row first: the leave waits for it (no deadlock), then revokes and switches auto-accept off', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.B, co.A, {}, U.b);
    const r = await serialised(inFlight(U.b, co.B, ON, [id, co.B]), leave(co.B, co.G));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect(await connection(id)).toEqual(REVOKED);
    expect((await side(id)).auto_accept).toBe(false);
  }, 30000);

  it('the leave comes first: the side update waits, then is refused (the connection is revoked)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.B, co.A, {}, U.b);
    const r = await serialised(leaving(co.B, co.G), (c) => c.query(ON, [id, co.B]), openSession(U.b, co.B));
    expect(r.waited).toBe(true);
    expect(r.second).toBe(R.sideRevoked);
    expect((await side(id)).auto_accept).toBe(false);
  }, 30000);
});

describe('accepting a message and a leave at the same moment', () => {
  it('the leave waits for the accepting transaction, then revokes the connection; the accepted message stays accepted', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });
    const r = await serialised(inFlight(U.b, co.B, "UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [m]), leave(co.B, co.G));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect((await connection(id)).status).toBe('revoked');
    expect((await pool.query('SELECT status FROM intercompany_messages WHERE id = $1', [m])).rows[0].status).toBe('accepted');
  }, 30000);
});
