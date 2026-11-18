/**
 * Intercompany (1002): rows that a revoke has to see. A side's first save, a message send and a link insert hold their
 * connection FOR SHARE, so a revoke in flight (manual, or by the system when a company leaves) is waited for and seen, and a
 * revoke that comes after waits for them and releases what they saved. And the lock-order reproducer: a leave that waits on a
 * connection row while a session switches a side's auto-accept on (three sessions) used to deadlock when deciders locked member
 * rows; it must serialise. Two or three real connections per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, party, plantConnection, plantDocument, plantSide, R, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';
import { LINK, acceptedMessage, high, linkRow, low, mirrorArgs, ownerOf, pairing } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const { openSession, pidOf, waitsOnLock, settle, sleep, connection, inFlight, serialised, leaving, leave, REVOKED } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
});

const SIDE = 'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, supplier_id, auto_accept) VALUES ($1, $2, $3, $4, $5)';
const MANUAL_REVOKE = "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1";
const sideOf = async (id: string) => (await pool.query('SELECT supplier_id, auto_accept FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.B])).rows[0];
const revokeByA = (id: string) => (c: import('pg').PoolClient) => c.query(MANUAL_REVOKE, [id]);

describe("a side's first save and a revoke at the same moment", () => {
  it.each([[false], [true]])('(auto_accept %s) the save is in flight first: a manual revoke waits, then releases it', async (auto) => {
    const id = await plantConnection(pool, co.A, co.B);
    const r = await serialised(inFlight(U.b, co.B, SIDE, [id, co.B, co.A, party.bSupplier, auto]), revokeByA(id), openSession(U.a, co.A), undefined, true);
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect(await connection(id)).toMatchObject({ status: 'revoked', revoked_by: U.a });
    expect(await sideOf(id)).toEqual({ supplier_id: null, auto_accept: false });
  }, 30000);

  it.each([[false], [true]])('(auto_accept %s) the save is in flight first: a leave waits, then releases it', async (auto) => {
    const id = await plantConnection(pool, co.A, co.B);
    const r = await serialised(inFlight(U.b, co.B, SIDE, [id, co.B, co.A, party.bSupplier, auto]), leave(co.B, co.G));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect(await connection(id)).toEqual(REVOKED);
    expect(await sideOf(id)).toEqual({ supplier_id: null, auto_accept: false });
  }, 30000);

  it('the revoke is in flight first: the first save waits for it, then is refused, and nothing is stored (so the supplier is free)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const r = await serialised(inFlight(U.a, co.A, MANUAL_REVOKE, [id]), (c) => c.query(SIDE, [id, co.B, co.A, party.bSupplier, true]), openSession(U.b, co.B));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: R.sideRevoked });
    expect(await sideOf(id)).toBeUndefined();
  }, 30000);

  it('a leave in flight first: the first save waits, then is refused', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const r = await serialised(leaving(co.B, co.G), (c) => c.query(SIDE, [id, co.B, co.A, party.bSupplier, false]), openSession(U.b, co.B));
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: R.sideRevoked });
    expect(await sideOf(id)).toBeUndefined();
  }, 30000);

  it('after a manual revoke and a re-activation the side starts with auto-accept off (the save that raced it was released)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await serialised(inFlight(U.b, co.B, SIDE, [id, co.B, co.A, party.bSupplier, true]), revokeByA(id), openSession(U.a, co.A), undefined, true);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id]), true);
    expect(await connection(id)).toMatchObject({ status: 'active' });
    expect(await sideOf(id)).toEqual({ supplier_id: null, auto_accept: false });
  }, 30000);
});

describe('a message send, a link insert and a revoke at the same moment', () => {
  it('a message in flight first: a manual revoke waits for it', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const send = "INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload) VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')";
    const r = await serialised(inFlight(U.ab, co.A, send, [id, co.A, co.B]), revokeByA(id), openSession(U.a, co.A), undefined, true);
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect((await connection(id)).status).toBe('revoked');
  }, 30000);

  it('a link insert in flight first: a manual revoke waits for it (the link is made while the connection is still active)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const r = await serialised(inFlight(U.b, co.B, LINK, mirrorArgs(id, co.A, m, src, tgt)), revokeByA(id), openSession(U.a, co.A), undefined, true);
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    const link = (await pool.query('SELECT id FROM intercompany_document_links WHERE connection_id = $1', [id])).rows[0].id as string;
    expect((await linkRow(pool, link)).status).toBe('active');
    expect((await connection(id)).status).toBe('revoked');
  }, 30000);

  it('the revoke in flight first: the link insert waits for it, then is refused', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const r = await serialised(inFlight(U.a, co.A, MANUAL_REVOKE, [id]), (c) => c.query(LINK, mirrorArgs(id, co.A, m, src, tgt)), openSession(U.b, co.B));
    expect(r.waited).toBe(true);
    expect(r.second).toBe('23514: documents are linked only on an active connection');
  }, 30000);
});

describe('confirming a pending pairing and a revoke at the same moment', () => {
  const CONFIRM = "UPDATE intercompany_document_links SET confirmed_by_b = 'x' WHERE id = $1";
  async function pending() {
    const id = await plantConnection(pool, co.A, co.B);
    const [a, b] = [await plantDocument(pool, 'customer_invoice', low()), await plantDocument(pool, 'supplier_invoice', high())];
    const link = await asAppUser(pool, ownerOf(low()), low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    return { id, link };
  }

  it('the confirmation in flight first: a manual revoke waits for it (the link is activated while the connection is active)', async () => {
    const { id, link } = await pending();
    const r = await serialised(inFlight(ownerOf(high()), high(), CONFIRM, [link]), revokeByA(id), openSession(U.a, co.A), undefined, true);
    expect(r).toEqual({ waited: true, firstEnd: 'ok', second: 'ok' });
    expect((await linkRow(pool, link)).status).toBe('active');
    expect((await connection(id)).status).toBe('revoked');
  }, 30000);

  it('the revoke in flight first: the confirmation waits for it, then is refused (no active link on a revoked connection)', async () => {
    const { id, link } = await pending();
    const r = await serialised(inFlight(U.a, co.A, MANUAL_REVOKE, [id]), (c) => c.query(CONFIRM, [link]), openSession(ownerOf(high()), high()));
    expect(r.waited).toBe(true);
    expect(r.second).toBe('23514: a link is confirmed only on an active connection');
    expect((await linkRow(pool, link)).status).toBe('pending_confirmation');
  }, 30000);
});

describe('lock order: a leave that waits on a connection row while a side is switched on (three sessions)', () => {
  it('serialises: no deadlock, the connection is revoked and the side ends with auto-accept off', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.B, co.A, {}, U.b);
    const holder = await inFlight(null, co.A, 'SELECT 1 FROM intercompany_connections WHERE id = $1 FOR UPDATE', [id]);   // holds the connection row
    const leaver = await pool.connect();
    const writer = await openSession(U.b, co.B);
    try {
      const leaverPid = await pidOf(leaver);
      let leaverDone = false;
      const leaving = settle(leaver.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B])).then((x) => { leaverDone = true; return x; });
      expect(await waitsOnLock(leaverPid, () => leaverDone), 'the leave waits on the connection row').toBe(true);
      // the writer switches auto-accept on while the leave waits (it holds its side row; its guard asks the topology)
      const switching = settle(writer.query('UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2', [id, co.B]));
      await sleep(600);
      await holder.query('COMMIT');
      expect(await switching).toBe('ok');
      await writer.query('COMMIT');
      expect(await leaving).toBe('ok');
      expect(await connection(id)).toEqual(REVOKED);
      expect(await sideOf(id)).toEqual({ supplier_id: null, auto_accept: false });
    } finally {
      for (const c of [holder, leaver, writer]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  }, 40000);
});
