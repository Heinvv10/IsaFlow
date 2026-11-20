/**
 * Intercompany (1002): a company document is in ONE link at a time, whatever the connection and the position (doc_a of the low
 * company on one connection, doc_b of the high company on another). intercompany_document_slots, kept by a definer trigger, holds a
 * slot for each VERIFIED side of a live link (active: both; pending: the side its inserter confirmed) and its primary key serialises
 * concurrent pairings. The unverified side of a pending pairing holds nothing (no squatting); mirror links are unchanged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, pairOf, plantConnection, plantDocument, plantMessage, R, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';
import { LINK } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const { openSession, inFlight, serialised } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [co.C, U.ab]);
  await cleanup(pool);
});

const UNLINK = "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1";
const slots = async () => (await pool.query('SELECT company_id, doc_type, doc_id FROM intercompany_document_slots')).rows;

/** Three companies of one group K, ordered by id: `mid` is the HIGH company of (lo, mid) and the LOW one of (mid, hi). */
let lo = '', mid = '', hi = '', group = '', loMid = '', midHi = '';
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [co.C, U.ab]);   // a writer of A, B and C
  [lo, mid, hi] = [co.A, co.B, co.C].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  group = crypto.randomUUID();
  await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC slots group K')", [group]);
  await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3), ($1, $4)', [group, co.A, co.B, co.C]);
  loMid = await plantConnection(pool, lo, mid, U.ab);
  midHi = await plantConnection(pool, mid, hi, U.ab);
  expect(pairOf(lo, mid)[1]).toBe(mid);
  expect(pairOf(mid, hi)[0]).toBe(mid);
});
afterEach(async () => {
  await wipeConnections(pool);
  await pool.query('DELETE FROM company_group_members WHERE group_id = $1', [group]);
  await pool.query('DELETE FROM company_groups WHERE id = $1', [group]);
});

/** `mid` pairs its own document `d` on the connection (lo, mid) (as doc_b) or (mid, hi) (as doc_a), as a session of mid. */
const asHigh = (d: string, other = crypto.randomUUID()) => [loMid, null, lo, 'customer_invoice', other, mid, 'supplier_invoice', d, 'manual_pairing'];
const asLow = (d: string, other = crypto.randomUUID()) => [midHi, null, mid, 'supplier_invoice', d, hi, 'customer_invoice', other, 'manual_pairing'];
const pair = (args: unknown[]) => asAppUser(pool, U.ab, mid, async (q) => (await q.query(LINK, args)).rows[0].id as string, true);
const tryPair = (args: unknown[]) => asAppUser(pool, U.ab, mid, (q) => outcome(q, LINK, args));

describe('one document in one link, across positions', () => {
  it('a document paired as doc_b on one connection cannot be paired as doc_a on another, and the other way round', async () => {
    const d = await plantDocument(pool, 'supplier_invoice', mid);
    const first = await pair(asHigh(d));
    expect(await tryPair(asLow(d))).toBe(R.docSlotTaken);
    await asAppUser(pool, U.ab, mid, (q) => q.query(UNLINK, [first]), true);
    const second = await pair(asLow(d));                                       // the slot is free again
    expect(await tryPair(asHigh(d))).toBe(R.docSlotTaken);
    expect(second).toBeTruthy();
  });

  it('the same position on two connections is refused too (a second pending pairing of the inserter\'s own document)', async () => {
    const d = await plantDocument(pool, 'supplier_invoice', mid);
    await pair(asHigh(d));
    const again = [loMid, null, lo, 'customer_invoice', crypto.randomUUID(), mid, 'supplier_invoice', d, 'manual_pairing'];
    expect(await tryPair(again)).toBe(R.docSlotTaken);
  });

  it('another document of the same company, and the same document id in another company, are not affected', async () => {
    const d = await plantDocument(pool, 'supplier_invoice', mid);
    const e = await plantDocument(pool, 'supplier_invoice', mid);
    await pair(asHigh(d));
    await pair(asLow(e));
    expect((await slots()).map((r) => r.doc_id).sort()).toEqual([d, e].sort());
  });

  it('confirming the other side takes its slot: a partner document already linked elsewhere cannot be confirmed in', async () => {
    const dMid = await plantDocument(pool, 'supplier_invoice', mid);
    await pair(asHigh(dMid));                                                  // mid's doc is now linked (pending, its side confirmed)
    // hi proposes a pairing naming mid's document as the (unverified) other side: it holds nothing, so it is accepted...
    const dHi = await plantDocument(pool, 'customer_invoice', hi);
    const proposal = await asAppUser(pool, U.ab, hi, async (q) => (await q.query(LINK, [midHi, null, mid, 'supplier_invoice', dMid, hi, 'customer_invoice', dHi, 'manual_pairing'])).rows[0].id as string, true);
    // ...but mid cannot confirm it: mid's document is taken
    await asAppUser(pool, U.ab, mid, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1", [proposal])).toBe(R.docSlotTaken);
    });
    expect((await pool.query('SELECT status FROM intercompany_document_links WHERE id = $1', [proposal])).rows[0].status).toBe('pending_confirmation');
  });

  it('the unverified side of a pending pairing holds nothing: a partner cannot squat a document by proposing it', async () => {
    const dMid = await plantDocument(pool, 'supplier_invoice', mid);
    const dHi = await plantDocument(pool, 'customer_invoice', hi);
    await asAppUser(pool, U.ab, hi, (q) => q.query(LINK, [midHi, null, mid, 'supplier_invoice', dMid, hi, 'customer_invoice', dHi, 'manual_pairing']), true);
    expect((await slots()).map((r) => r.company_id)).toEqual([hi]);           // only hi's own document
    await pair(asHigh(dMid));                                                  // mid can still pair its own document
  });
});

describe('concurrent pairings of one document', () => {
  it.each([['doc_b then doc_a', true], ['doc_a then doc_b', false]])('across positions (%s): the second waits for the first, then is refused', async (_label, highFirst) => {
    const d = await plantDocument(pool, 'supplier_invoice', mid);
    const [firstArgs, secondArgs] = highFirst ? [asHigh(d), asLow(d)] : [asLow(d), asHigh(d)];
    const r = await serialised(inFlight(U.ab, mid, LINK, firstArgs), (c) => c.query(LINK, secondArgs), openSession(U.ab, mid));
    expect(r).toEqual({ waited: 'lock', firstEnd: 'ok', second: R.docSlotTaken });
    expect((await slots()).filter((s) => s.doc_id === d)).toHaveLength(1);
  }, 30000);

  it('if the first rolls back, the second goes through', async () => {
    const d = await plantDocument(pool, 'supplier_invoice', mid);
    const first = await inFlight(U.ab, mid, LINK, asHigh(d));
    const second = await openSession(U.ab, mid);
    try {
      const pending = second.query(LINK, asLow(d)).then(() => 'ok', (e: { message: string }) => e.message);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await first.query('ROLLBACK');
      expect(await pending).toBe('ok');
      await second.query('COMMIT');
    } finally {
      for (const c of [first, second]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
    expect((await slots()).filter((s) => s.doc_id === d)).toHaveLength(1);
  }, 30000);
});

describe('the slots follow the link', () => {
  it('a mirror link holds both documents; unlinking frees them; a deleted connection frees them (cascade)', async () => {
    const src = await plantDocument(pool, 'customer_invoice', lo);
    const tgt = await plantDocument(pool, 'supplier_invoice', mid);
    const m = await plantMessage(pool, loMid, lo, mid, { kind: 'invoice', doc: src, user: U.ab });
    await asAppUser(pool, U.ab, mid, (q) => q.query("UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $2 WHERE id = $1", [m, tgt]), true);
    const link = await pair([loMid, m, lo, 'customer_invoice', src, mid, 'supplier_invoice', tgt, 'mirror']);
    expect((await slots()).map((r) => r.doc_id).sort()).toEqual([src, tgt].sort());
    await asAppUser(pool, U.ab, mid, (q) => q.query(UNLINK, [link]), true);
    expect(await slots()).toEqual([]);
    const again = await plantDocument(pool, 'supplier_invoice', mid);
    await pair(asHigh(again));
    expect(await slots()).toHaveLength(1);
    await pool.query('DELETE FROM intercompany_connections WHERE id = $1', [loMid]);
    expect(await slots()).toEqual([]);
  });

  it('rows 1000 may already hold are given their slots by the migration (active: both; pending: the confirmed side only), and it can be applied twice', async () => {
    const [a1, b1, a2, b2] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const MIGRATION = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1002_intercompany_round2.sql'), 'utf8');
    const section = MIGRATION.slice(MIGRATION.indexOf('-- Rows 1000 may already hold (the duplicates check'), MIGRATION.indexOf('-- ── 7. A revoked connection'));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_link_slots');
      await client.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_links_guard');
      const insert = `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, confirmed_by_a, created_by)
                      VALUES ($1, $2, 'supplier_invoice', $3, $4, 'customer_invoice', $5, 'manual_pairing', $6, 'x', 'x')`;
      await client.query(insert, [midHi, mid, a1, hi, b1, 'active']);
      await client.query(insert, [midHi, mid, a2, hi, b2, 'pending_confirmation']);
      await client.query(section);
      await client.query(section);
      const rows = (await client.query('SELECT doc_id FROM intercompany_document_slots')).rows.map((r) => r.doc_id as string).sort();
      expect(rows).toEqual([a1, b1, a2].sort());                     // the pending pairing's B side is unverified: no slot
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the slot function is a registered definer no app role can execute', async () => {
    const f = (await pool.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              (SELECT count(*) FROM app_definer_reviews r WHERE r.signature = p.oid::regprocedure::text AND r.body_md5 = app_definer_hash(p.oid)) AS reviewed
         FROM pg_proc p WHERE p.proname = 'intercompany_link_slots_sync'`)).rows[0];
    expect(f).toMatchObject({ prosecdef: true, owner: 'migration_admin', app_user: false, public_exec: false, reviewed: '1' });
    expect(f.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });
});
