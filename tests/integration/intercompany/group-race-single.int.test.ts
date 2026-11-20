/**
 * Intercompany (1002): what the matrix cannot express. A group of ONE company whose member leaves (or whose group is deactivated)
 * while another company joins it and a creator relies on the join: the changer must always take its own company's row, so it is
 * ordered against the join and against the creator the join enables. A late joiner. And a viewer's hold on its own pair, which must
 * not cascade to pairs that share no group with its company (a changer that is waiting holds nothing).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { companies } from './intercompany.fixture';
import { cleanup, co, pairOf, plantConnection, R, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const { openSession, inFlight, serialised, connection, REVOKED, LEAVE } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await resetH(); await cleanup(pool); });
beforeEach(async () => { await wipeConnections(pool); await resetH(); });
afterEach(async () => { await wipeConnections(pool); await resetH(); });

/** H is the group of one company (C): put it back. */
async function resetH() {
  await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id <> $2', [co.H, co.C]);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.H]);
  await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.H]);
}
const JOIN = 'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)';
const CREATE = "INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id) VALUES ($1, $2, 'group', 'active', $1) RETURNING id";
const none = async () => (await pool.query('SELECT count(*)::int AS n FROM intercompany_connections')).rows[0].n as number;

/** After the change and the join have both committed, a creator of (A, C) relies on the join: it must be refused. */
async function creatorIsRefused() {
  const [low, high] = pairOf(co.A, co.C);
  const session = await openSession(U.ac, low);
  try {
    await session.query('SET LOCAL lock_timeout = \'3s\'');
    await expect(session.query(CREATE, [low, high])).rejects.toMatchObject({ message: R.needsOneGroup.slice(R.needsOneGroup.indexOf(' ') + 1) });
  } finally {
    await session.query('ROLLBACK');
    session.release();
  }
  expect(await none()).toBe(0);
}

const CHANGES: Record<string, () => [string, string[]]> = {
  'its member leaves': () => [LEAVE, [co.H, co.C]],
  'the group is deactivated': () => ['UPDATE company_groups SET is_active = false WHERE id = $1', [co.H]],
};

describe('a group of one company: its change, a join and the creator the join enables', () => {
  it.each(Object.keys(CHANGES))('the change in flight first (%s): the join waits for it, then the creator is refused', async (name) => {
    const [change, args] = CHANGES[name]();
    const r = await serialised(inFlight(null, co.C, change, args), (c) => c.query(JOIN, [co.H, co.A]));
    expect(r).toEqual({ waited: 'lock', firstEnd: 'ok', second: 'ok' });
    await creatorIsRefused();
  }, 30000);

  it.each(Object.keys(CHANGES))('the join in flight first (%s): the change waits for it, sees the joiner, and the creator is refused', async (name) => {
    const [change, args] = CHANGES[name]();
    const r = await serialised(inFlight(null, co.A, JOIN, [co.H, co.A]), (c) => c.query(change, args));
    expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
    await creatorIsRefused();
  }, 30000);

  it('a re-join (left_date back to NULL) in flight first: the change waits for it, and the creator is refused', async () => {
    await pool.query(JOIN, [co.H, co.A]);
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.H, co.A]);
    const r = await serialised(inFlight(null, co.A, 'UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.H, co.A]), (c) => c.query(LEAVE, [co.H, co.C]));
    expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
    await creatorIsRefused();
  }, 30000);

  it('a connection created while the joiner is in flight is refused too: the join is not committed, so C is alone in H', async () => {
    const holder = await inFlight(null, co.A, JOIN, [co.H, co.A]);
    try {
      await creatorIsRefused();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 30000);

  it('a leave in flight, then a join, then a creator: the end state has no active connection and a shared-group-less pair is impossible', async () => {
    const leaving = await inFlight(null, co.C, LEAVE, [co.H, co.C]);
    const joiner = await pool.connect();
    let joined = false;
    const join = joiner.query(JOIN, [co.H, co.A]).then(() => { joined = true; });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(joined).toBe(false);                      // the join waits for the leave: the breaker's three-step race cannot happen
    await leaving.query('COMMIT');
    leaving.release();
    await join;
    joiner.release();
    await creatorIsRefused();
  }, 30000);
});

describe('a viewer holding its own pair does not stall pairs that share no group with its company', () => {
  it('E-F is held by a viewer of E; F leaves G2 (F, Cc, D); sends on Cc-D and W-Cc and F-Cc still go through while the leave waits', async () => {
    const mk = async (name: string) => {
      const id = crypto.randomUUID();
      await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [id, `IC cascade ${name}`]);
      await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [id, U.ab]);
      companies.push(id);
      return id;
    };
    const [E, F, Cc, W, D] = [await mk('E'), await mk('F'), await mk('C'), await mk('W'), await mk('D')];
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'viewer')", [E, U.va]);
    const groups = { g1: [E, F], g2: [F, Cc, D], g3: [Cc, W] };
    const made: string[] = [];
    for (const members of Object.values(groups)) {
      const g = crypto.randomUUID();
      made.push(g);
      await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC cascade group')", [g]);
      await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, c FROM unnest($2::uuid[]) c', [g, members]);
    }
    try {
      const ef = await plantConnection(pool, E, F, U.ab);
      const fc = await plantConnection(pool, F, Cc, U.ab);
      const cd = await plantConnection(pool, Cc, D, U.ab);
      const wc = await plantConnection(pool, W, Cc, U.ab);
      const send = (id: string, from: string, to: string) => async () => {
        const s = await openSession(U.ab, from);
        try {
          await s.query("SET LOCAL lock_timeout = '1500ms'");
          await s.query('INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload) VALUES ($1, $2, $3, \'payment\', \'payment\', gen_random_uuid(), \'{}\')', [id, from, to]);
          await s.query('COMMIT');
        } finally {
          s.release();
        }
      };
      const r = await serialised(
        inFlight(U.va, E, 'SELECT public.intercompany_in_one_group($1, $2), pg_sleep(0)', [E, F]),
        (c) => c.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [made[1], F]),
        undefined,
        async () => { await send(cd, Cc, D)(); await send(wc, W, Cc)(); await send(fc, F, Cc)(); });
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
      expect(await connection(fc)).toEqual(REVOKED);
      expect((await connection(cd)).status).toBe('active');
      expect((await connection(wc)).status).toBe('active');
      expect((await connection(ef)).status).toBe('active');
    } finally {
      await wipeConnections(pool);
      await pool.query('DELETE FROM company_groups WHERE id = ANY($1)', [made]);
      await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [E, U.va]);
    }
  }, 40000);
});
