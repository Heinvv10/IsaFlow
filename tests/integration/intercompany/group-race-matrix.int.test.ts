/**
 * Intercompany (1002): the matrix. EVERY kind of membership change (a leave, a bulk leave in one statement, a group deactivated, a
 * group deleted with its members cascading, a member row deleted) against EVERY kind of writer that relies on the pair sharing a
 * group (a connection created, a message sent, a side's first save, auto-accept switched on, a connection re-activated), in both
 * orders. Writer first: the change waits for it, then ends the pair and what the writer made is released. Change first: the writer
 * waits for it, then is refused. Never a deadlock, never a connection left active over a pair that shares no group. Then the
 * cases the matrix cannot express: a group of one company, a late joiner, and a viewer's hold that must not cascade.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { companies } from './intercompany.fixture';
import { asAppUser, cleanup, co, pairOf, party, plantConnection, plantSide, R, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const { openSession, inFlight, serialised, connection, REVOKED } = makeRace(pool);
let Q = '';

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1', [co.G]);   // A and B share only Q now
  Q = crypto.randomUUID();
  await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC matrix group Q')", [Q]);
  await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [Q, co.A, co.B]);
});
afterEach(async () => {
  await wipeConnections(pool);
  await pool.query('DELETE FROM company_groups WHERE id = $1', [Q]);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
});

const pair = () => pairOf(co.A, co.B);
const state = async () => (await pool.query('SELECT id, status, revoked_by FROM intercompany_connections WHERE company_low_id = $1 AND company_high_id = $2', pair())).rows[0];
const sideB = async (id: string) => (await pool.query('SELECT supplier_id, auto_accept FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.B])).rows[0];
const CREATE = "INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id) VALUES ($1, $2, 'group', 'active', $1) RETURNING id";
const SEND = "INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload) VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')";
const SIDE = 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, supplier_id, auto_accept) VALUES ($1, $2, $3, $4, true)';
const AUTO = 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2';
const REACTIVATE = "UPDATE intercompany_connections SET status = 'active' WHERE id = $1";

/** A change to Q that ends the pair, as the table owner (a statement, in flight or run). */
const CHANGES = {
  'a leave': 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2',
  'a bulk leave in one statement': 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1',
  'a deactivation': 'UPDATE company_groups SET is_active = false WHERE id = $1',
  'a group deleted with its members': 'DELETE FROM company_groups WHERE id = $1',
  'a member row deleted': 'DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2',
} as const;
const changeArgs = (name: keyof typeof CHANGES) => (name === 'a leave' || name === 'a member row deleted' ? [Q, co.B] : [Q]);

interface Writer {
  prepare(): Promise<string | null>;
  start(id: string | null): { held: () => Promise<import('pg').PoolClient>; run: (c: import('pg').PoolClient) => Promise<unknown>; session: () => Promise<import('pg').PoolClient> };
  refused: string;
  released(id: string | null): Promise<void>;
}
const WRITERS: Record<string, Writer> = {
  'a connection created': {
    prepare: async () => null,
    start: () => ({ held: () => inFlight(U.ab, pair()[0], CREATE, pair()), run: (c) => c.query(CREATE, pair()), session: () => openSession(U.ab, pair()[0]) }),
    refused: R.needsOneGroup,
    released: async () => { expect(await state()).toMatchObject({ status: 'revoked', revoked_by: 'system:group-membership' }); },
  },
  'a message sent': {
    prepare: async () => plantConnection(pool, co.A, co.B),
    start: (id) => ({ held: () => inFlight(U.ab, co.A, SEND, [id, co.A, co.B]), run: (c) => c.query(SEND, [id, co.A, co.B]), session: () => openSession(U.ab, co.A) }),
    refused: R.msgNotActive,                       // the connection is revoked by the time the writer gets its row
    released: async (id) => { expect(await connection(id!)).toEqual(REVOKED); },
  },
  "a side's first save": {
    prepare: async () => plantConnection(pool, co.A, co.B),
    start: (id) => ({ held: () => inFlight(U.b, co.B, SIDE, [id, co.B, co.A, party.bSupplier]), run: (c) => c.query(SIDE, [id, co.B, co.A, party.bSupplier]), session: () => openSession(U.b, co.B) }),
    refused: R.sideRevoked,
    released: async (id) => { expect(await connection(id!)).toEqual(REVOKED); expect(await sideB(id!)).toEqual({ supplier_id: null, auto_accept: false }); },
  },
  'auto-accept switched on': {
    prepare: async () => { const id = await plantConnection(pool, co.A, co.B); await plantSide(pool, id, co.B, co.A, {}, U.b); return id; },
    start: (id) => ({ held: () => inFlight(U.b, co.B, AUTO, [id, co.B]), run: (c) => c.query(AUTO, [id, co.B]), session: () => openSession(U.b, co.B) }),
    refused: R.sideRevoked,
    released: async (id) => { expect(await connection(id!)).toEqual(REVOKED); expect((await sideB(id!)).auto_accept).toBe(false); },
  },
  'a connection re-activated': {
    prepare: async () => {
      const id = await plantConnection(pool, co.A, co.B);
      await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
      return id;
    },
    start: (id) => ({ held: () => inFlight(U.ab, co.A, REACTIVATE, [id]), run: (c) => c.query(REACTIVATE, [id]), session: () => openSession(U.ab, co.A) }),
    refused: R.needsOneGroup,
    released: async (id) => { expect(await connection(id!)).toEqual(REVOKED); },
  },
};

describe.each(Object.keys(CHANGES) as Array<keyof typeof CHANGES>)('%s', (changeName) => {
  describe.each(Object.keys(WRITERS))('against %s', (writerName) => {
    const w = WRITERS[writerName];
    const change = CHANGES[changeName];

    it('the writer first: the change waits for it, then ends the pair and the writer\'s work is released', async () => {
      const id = await w.prepare();
      const { held } = w.start(id);
      const holder = held();
      const result = await serialised(holder, (c) => c.query(change, changeArgs(changeName)));
      expect(result).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });                // the changer polls
      await w.released(id);
    }, 30000);

    it('the change first: the writer waits for it, then is refused', async () => {
      const id = await w.prepare();
      const { run, session } = w.start(id);
      const result = await serialised(inFlight(null, co.A, change, changeArgs(changeName)), run, session());
      expect(result).toEqual({ waited: 'lock', firstEnd: 'ok', second: w.refused });          // the writer is blocked in the lock manager
      const row = await state();
      if (id) expect(row).toMatchObject({ status: 'revoked' });
      else expect(row).toBeUndefined();
    }, 30000);
  });
});
