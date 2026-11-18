/**
 * Intercompany (1002): a session can only ever delay work that involves a company its user belongs to. A stranger (a user of a
 * company that shares no group with the pair), a user asking about an ungrouped pair, a group of one company and a no-op
 * is_active toggle take no lock that anyone else waits for; a leave locks only the companies it could end a connection between;
 * concurrent leaves of one pair still serialise (group-race suites). The stranger holds the transaction open: the pair's leave and
 * the pair's send must not wait for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, plantConnection, setup, U, wipeConnections } from './intercompany.helpers';
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
  await pool.query('DELETE FROM intercompany_company_locks');
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
const rowsOf = async () => (await pool.query('SELECT company_id FROM intercompany_company_locks')).rows.map((r) => r.company_id as string).sort();

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
async function connect(): Promise<string> {
  const id = await plantConnection(pool, co.A, co.B);
  await pool.query('DELETE FROM intercompany_company_locks');        // creating it took (and released) the pair's rows
  return id;
}

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

  it('a stranger toggling its own group (a group of one company, is_active to itself or off) holds nothing', async () => {
    const id = await connect();
    const holder = await inFlight(U.c, co.C, 'UPDATE company_groups SET is_active = true WHERE id = $1', [co.H]);
    await holder.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.H]);
    await holds(holder, [], id);
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
});

describe('what a party to a grouped pair holds: its own companies, and only them', () => {
  it('asking about the pair holds the two companies, and not C', async () => {
    await plantConnection(pool, co.A, co.B);                          // its creation committed the pair's rows
    await holds(await inFlight(U.a, co.A, ASK, [co.A, co.B]), [co.A, co.B], null);
    expect(await rowsOf()).toEqual([co.A, co.B].sort());
  }, 30000);

  it('a leave of B from G (members A and B) takes A and B, not C; the definers create the rows', async () => {
    await connect();
    await pool.query(LEAVE, [co.G, co.B]);
    expect(await rowsOf()).toEqual([co.A, co.B].sort());
  });

  it('a leave that cannot end anything (the group has no other member) takes nothing', async () => {
    await pool.query(LEAVE, [co.H, co.C]);
    expect(await rowsOf()).toEqual([]);
  });

  it('re-activating a group, leaving again a group already left, and deactivating a group already inactive take nothing', async () => {
    await pool.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]);
    await pool.query('DELETE FROM intercompany_company_locks');
    await pool.query('UPDATE company_groups SET is_active = false WHERE id = $1', [co.G]);                                                   // inactive already
    await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);                                                    // a re-activation
    expect(await rowsOf()).toEqual([]);
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
    await pool.query('DELETE FROM intercompany_company_locks');
    await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE - 1 WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);   // left already
    expect(await rowsOf()).toEqual([]);
  });
});
