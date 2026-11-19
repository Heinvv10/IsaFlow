/**
 * Intercompany (1002): a session can only ever delay work that involves a company its user belongs to. A stranger (a user of a
 * company that shares no group with the pair), a user asking about an ungrouped pair, a claim-less session and a change that
 * changes nothing (a no-op is_active toggle, SET left_date = left_date) hold no lock; a group of one company holds only its own
 * row; a leave holds only the companies it could end a connection between; every company has its lock row from the start (a first
 * decision never waits for another session's insert). The holder keeps the transaction open: the pair's leave and send must not
 * wait for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, plantConnection, setup, U, wipeConnections } from './intercompany.helpers';
import { companies } from './intercompany.fixture';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const { inFlight, LEAVE, connection, REVOKED } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await pool.query('UPDATE company_groups SET is_active = true WHERE id = ANY($1)', [[co.G, co.H]]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await pool.query('UPDATE company_groups SET is_active = true WHERE id = ANY($1)', [[co.G, co.H]]);
});

const ASK = 'SELECT public.intercompany_in_one_group($1, $2) AS ok, pg_sleep(0)';
const SEND = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
              VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')`;

/** The companies whose lock row is HELD right now by some open transaction (a FOR UPDATE NOWAIT on the row fails), sorted. */
async function held(): Promise<string[]> {
  const out: string[] = [];
  const probe = await pool.connect();
  try {
    for (const { company_id: company } of (await pool.query('SELECT company_id FROM intercompany_company_locks')).rows as Array<{ company_id: string }>) {
      await probe.query('BEGIN');
      try {
        await probe.query('SELECT 1 FROM intercompany_company_locks WHERE company_id = $1 FOR UPDATE NOWAIT', [company]);
      } catch (err) {
        if ((err as { code?: string }).code !== '55P03') throw err;
        out.push(company);
      } finally {
        await probe.query('ROLLBACK');
      }
    }
  } finally {
    probe.release();
  }
  return out.sort();
}

/** `holder` is an open transaction. The pair's send and leave (2 s lock timeout) must not wait for it. */
async function holds(holder: PoolClient, expectHeld: string[], id: string | null) {
  try {
    expect(await held()).toEqual([...expectHeld].sort());
    if (id) {
      const leaver = await pool.connect();
      try {
        await leaver.query("SET lock_timeout = '2s'");
        const t0 = Date.now();
        await asAppUser(pool, U.ab, co.A, async (q) => { await q.query("SET LOCAL lock_timeout = '2s'"); await q.query(SEND, [id, co.A, co.B]); }, true);
        await leaver.query(LEAVE, [co.G, co.B]);
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(await connection(id)).toEqual(REVOKED);
      } finally {
        leaver.release();
      }
    }
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}
const connect = () => plantConnection(pool, co.A, co.B);

describe('what a session that is not a party to the pair can hold', () => {
  it('a user of an unrelated company asking about (its company, A) holds nothing: the pair\'s send and leave do not wait', async () => {
    const id = await connect();
    const holder = await inFlight(U.c, co.C, ASK, [co.C, co.A]);
    expect((await holder.query(ASK, [co.C, co.A])).rows[0].ok).toBe(false);
    await holds(holder, [], id);
  }, 30000);

  it('a viewer of A asking about (A, an ungrouped company) holds nothing either', async () => {
    const id = await connect();
    await holds(await inFlight(U.va, co.A, ASK, [co.A, co.C]), [], id);
  }, 30000);

  it('a stranger deactivating its own group (a group of one company) holds its own company row, and only that', async () => {
    const id = await connect();
    const holder = await inFlight(U.c, co.C, 'UPDATE company_groups SET is_active = false WHERE id = $1', [co.H]);
    await holds(holder, [co.C], id);
  }, 30000);

  it('a stranger leaving its own group (a group of one company) holds its own company row, and only that', async () => {
    const id = await connect();
    await holds(await inFlight(U.c, co.C, LEAVE, [co.H, co.C]), [co.C], id);
  }, 30000);

  it('a claim-less session asking about the pair holds nothing', async () => {
    const id = await connect();
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SET LOCAL ROLE app_user');
    await holder.query("SELECT set_config('app.current_company_id', $1, true)", [co.A]);
    expect((await holder.query(ASK, [co.A, co.B])).rows[0].ok).toBe(false);
    await holds(holder, [], id);
  }, 30000);

  it('a no-op toggle of the pair\'s own group by its writer (is_active true to true) holds nothing', async () => {
    const id = await connect();
    await holds(await inFlight(U.a, co.A, 'UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]), [], id);
  }, 30000);


  it('SET left_date = left_date on a current member (a no-op) holds nothing', async () => {
    const id = await connect();
    await holds(await inFlight(U.a, co.A, 'UPDATE company_group_members SET left_date = left_date WHERE group_id = $1 AND company_id = $2', [co.G, co.A]), [], id);
  }, 30000);

  it('a no-op on the company or group of a membership (SET company_id = company_id) holds nothing', async () => {
    await connect();
    await holds(await inFlight(null, co.A, 'UPDATE company_group_members SET company_id = company_id, group_id = group_id WHERE group_id = $1', [co.G]), [], null);
  }, 30000);

  it('re-activating a group, deactivating one already inactive and leaving again a member already left hold nothing', async () => {
    await pool.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]);
    await holds(await inFlight(null, co.A, 'UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]), [], null);
    await holds(await inFlight(null, co.A, 'UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]), [], null);
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    await holds(await inFlight(null, co.A, 'UPDATE company_group_members SET left_date = CURRENT_DATE - 1 WHERE group_id = $1 AND company_id = $2', [co.G, co.B]), [], null);
  }, 30000);
});

describe('what a party to a grouped pair holds: its own companies, and only them', () => {
  it('asking about the pair holds the two companies, and not C', async () => {
    await connect();
    await holds(await inFlight(U.a, co.A, ASK, [co.A, co.B]), [co.A, co.B], null);
  }, 30000);

  it('a leave of B from G (members A and B) holds A and B, not C', async () => {
    await connect();
    await holds(await inFlight(null, co.B, LEAVE, [co.G, co.B]), [co.A, co.B], null);
  }, 30000);

  it('a company that joins G is held with the group\'s members until the join commits', async () => {
    const holder = await inFlight(null, co.C, 'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)', [co.G, co.C]);
    await holds(holder, [co.A, co.B, co.C], null);
  }, 30000);
});

describe('a lock row that is somehow missing is created by the decider (and the decision still goes through)', () => {
  it('the row of A is deleted: asking about (A, B) re-creates it and still answers', async () => {
    await connect();
    await pool.query('DELETE FROM intercompany_company_locks WHERE company_id = $1', [co.A]);
    const holder = await inFlight(U.a, co.A, ASK, [co.A, co.B]);
    try {
      expect((await holder.query(ASK, [co.A, co.B])).rows[0].ok).toBe(true);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [co.A])).rows[0].n).toBe(1);
  }, 30000);
});

describe('the lock rows exist before anyone decides', () => {
  it('every company has its row, a company inserted gets one from the trigger, and a first decision on a pair does not block another pair', async () => {
    expect((await pool.query('SELECT count(*)::int AS n FROM companies c WHERE NOT EXISTS (SELECT 1 FROM intercompany_company_locks l WHERE l.company_id = c.id)')).rows[0].n).toBe(0);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) await pool.query("INSERT INTO companies(id, name) VALUES ($1, 'IC lock probe')", [id]);
    companies.push(...ids);
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = ANY($1)', [ids])).rows[0].n).toBe(3);
    // two sessions decide on two pairs that share a company for the first time; neither waits for the other
    const g = crypto.randomUUID();
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC lock probe group')", [g]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, c FROM unnest($2::uuid[]) c', [g, ids]);
    for (const id of ids) await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [id, U.ab]);
    const first = await inFlight(U.ab, ids[0], ASK, [ids[0], ids[1]]);
    const second = await inFlight(U.ab, ids[1], 'SET LOCAL lock_timeout = \'1s\'');
    try {
      expect((await second.query(ASK, [ids[1], ids[2]])).rows[0].ok).toBe(true);
      expect((await second.query(ASK, [ids[0], ids[1]])).rows[0].ok).toBe(true);       // shares share
    } finally {
      for (const c of [first, second]) { await c.query('ROLLBACK'); c.release(); }
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [g]);
      await pool.query('DELETE FROM company_groups WHERE id = $1', [g]);
    }
  }, 30000);
});
