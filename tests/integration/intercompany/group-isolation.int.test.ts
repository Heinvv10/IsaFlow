/**
 * Intercompany (1002): the protocol re-reads under its locks and needs READ COMMITTED's per-statement snapshot. At REPEATABLE READ
 * or SERIALIZABLE the re-read would reuse the transaction's snapshot and miss what committed meanwhile (the lock rows are only
 * locked, never updated, so no serialization failure would catch it). Every path that relies on the re-read refuses with 40001,
 * as migration 886 does for company_users: a connection created, re-activated, a message sent, auto-accept or a side saved, a
 * member joined or re-joined, and every membership or group change. READ COMMITTED (and READ UNCOMMITTED, which is the same in
 * Postgres) are unchanged, and the nested updates of a foreign key's SET NULL and of a revoke's release still pass at any level.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, pairOf, party, plantConnection, plantSide, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const LEVELS = ['REPEATABLE READ', 'SERIALIZABLE'];
const REFUSED = /^40001: intercompany group changes need READ COMMITTED isolation/;

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]); await cleanup(pool); });
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
});

/** A session as withAuth opens one, in a transaction at `level` whose snapshot is taken (the first statement). */
async function openAt(level: string, user: string | null, company: string): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`BEGIN ISOLATION LEVEL ${level}`);
  if (user) {
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  } else {
    await client.query('SELECT 1');
  }
  return client;
}
async function at(level: string, user: string | null, company: string, text: string, params: unknown[] = []): Promise<string> {
  const c = await openAt(level, user, company);
  try {
    return await outcome(c, text, params);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const CREATE = "INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id) VALUES ($1, $2, 'group', 'active', $1)";
const SEND = "INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload) VALUES ($1, $2, $3, 'reject', 'payment', gen_random_uuid(), '{}')";
const CHANGES: Record<string, string> = {
  'a leave': 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2',
  'a bulk leave': 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1',
  'a deactivation': 'UPDATE company_groups SET is_active = false WHERE id = $1',
  'a member row deleted': 'DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2',
  'a group deleted': 'DELETE FROM company_groups WHERE id = $1',
};

describe.each(LEVELS)('at %s', (level) => {
  it('a connection cannot be created', async () => {
    const [low, high] = pairOf(co.A, co.B);
    expect(await at(level, U.ab, low, CREATE, [low, high])).toMatch(REFUSED);
  });

  it('a connection cannot be created even when the leave that ends the pair committed after this transaction\'s snapshot (the breaker\'s repro)', async () => {
    const [low, high] = pairOf(co.A, co.B);
    const creator = await openAt(level, U.ab, low);
    try {
      await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);   // committed: G was the pair's only group
      expect(await outcome(creator, CREATE, [low, high])).toMatch(REFUSED);
    } finally {
      await creator.query('ROLLBACK');
      creator.release();
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_connections')).rows[0].n).toBe(0);
  });

  it('a revoked connection cannot be re-activated', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    expect(await at(level, U.ab, co.A, "UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id])).toMatch(REFUSED);
  });

  it('a message cannot be sent', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    expect(await at(level, U.ab, co.A, SEND, [id, co.A, co.B])).toMatch(REFUSED);
  });

  it('a side cannot be saved or switched to auto-accept, whatever the connection\'s state (the breaker\'s revoked-connection repro included)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    expect(await at(level, U.b, co.B, 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, supplier_id) VALUES ($1, $2, $3, $4)', [id, co.B, co.A, party.bSupplier])).toMatch(REFUSED);
    await plantSide(pool, id, co.B, co.A, {}, U.b);
    const holder = await openAt(level, U.b, co.B);                                   // snapshot taken: the connection is active
    try {
      await pool.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.A]);   // revokes it
      expect(await outcome(holder, 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2', [id, co.B])).toMatch(REFUSED);
      expect(await outcome(holder, 'UPDATE intercompany_connection_sides SET supplier_id = $3 WHERE connection_id = $1 AND company_id = $2', [id, co.B, party.bSupplier])).toMatch(REFUSED);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await pool.query('SELECT auto_accept, supplier_id FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.B])).rows[0]).toEqual({ auto_accept: false, supplier_id: null });
  });

  it('the nested updates still pass: a hard-deleted customer a side names is nulled at this level too', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const customer = crypto.randomUUID();
    await pool.query("INSERT INTO customers(id, company_id, name) VALUES ($1, $2, 'IC isolation customer')", [customer, co.A]);
    await plantSide(pool, id, co.A, co.B, { customer_id: customer }, U.a);
    const c = await openAt(level, null, co.A);
    try {
      expect(await outcome(c, 'DELETE FROM customers WHERE id = $1', [customer])).toBe('ok');            // the foreign key's SET NULL: depth 2
      expect((await c.query('SELECT customer_id FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.A])).rows[0].customer_id).toBeNull();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await pool.query('DELETE FROM customers WHERE id = $1', [customer]);
  });

  it('a company cannot join a group, or re-join', async () => {
    expect(await at(level, null, co.A, 'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)', [co.H, co.A])).toMatch(REFUSED);
    await pool.query('INSERT INTO company_group_members(group_id, company_id, left_date) VALUES ($1, $2, CURRENT_DATE) ON CONFLICT DO NOTHING', [co.H, co.A]);
    expect(await at(level, null, co.A, 'UPDATE company_group_members SET left_date = NULL WHERE group_id = $1 AND company_id = $2', [co.H, co.A])).toMatch(REFUSED);
    await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.H, co.A]);
  });

  it.each(Object.keys(CHANGES))('%s is refused (and nothing changes)', async (name) => {
    const id = await plantConnection(pool, co.A, co.B);
    const params = name === 'a bulk leave' || name === 'a deactivation' || name === 'a group deleted' ? [co.G] : [co.G, co.B];
    expect(await at(level, null, co.A, CHANGES[name], params)).toMatch(REFUSED);
    expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('active');
    expect((await pool.query('SELECT count(*)::int AS n FROM company_group_members WHERE group_id = $1 AND left_date IS NULL', [co.G])).rows[0].n).toBe(2);
  });
});

describe.each(['READ COMMITTED', 'READ UNCOMMITTED'])('at %s nothing changes', (level) => {
  it('a connection is created, a message is sent, a member leaves and the pair is ended', async () => {
    const [low, high] = pairOf(co.A, co.B);
    expect(await at(level, U.ab, low, CREATE, [low, high])).toBe('ok');
    const id = await plantConnection(pool, co.A, co.B);
    expect(await at(level, U.ab, co.A, SEND, [id, co.A, co.B])).toBe('ok');
    const c = await openAt(level, null, co.A);
    try {
      await c.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]);
      expect((await c.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('revoked');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
