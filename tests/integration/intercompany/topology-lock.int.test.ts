/**
 * Intercompany (1002): the topology lock is a row no app role can touch (a public advisory key could be held by any session, for
 * the length of its connection, to stall every tenant); 1002's per-company unique indexes (accepted message target, active link
 * document) hold whatever the connection and refuse to be created over duplicate data, naming the rows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, plantConnection, pairOf, plantLink, plantMessage, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const { openSession, LEAVE } = makeRace(pool);
const MIGRATION = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1002_intercompany_round2.sql'), 'utf8');

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
});

describe('intercompany_topology_lock', () => {
  it('is one row, owned by migration_admin, with no privilege for any app role or PUBLIC', async () => {
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_topology_lock')).rows[0].n).toBe(1);
    await expect(pool.query('INSERT INTO intercompany_topology_lock(id) VALUES (false)')).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('INSERT INTO intercompany_topology_lock(id) VALUES (true)')).rejects.toMatchObject({ code: '23505' });
    const t = (await pool.query("SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity FROM pg_class WHERE relname = 'intercompany_topology_lock'")).rows[0];
    expect(t).toEqual({ owner: 'migration_admin', relrowsecurity: true });
    for (const role of ['app_user', 'app_service', 'public']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        for (const table of ['intercompany_topology_lock', 'intercompany_document_slots']) {
          expect((await pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, priv])).rows[0].ok, `${role} ${priv} ${table}`).toBe(false);
        }
      }
    }
    // the slots table (link documents) is closed the same way, and says so in a policy as well (the RLS census wants one)
    const slots = (await pool.query("SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity, (SELECT count(*)::int FROM pg_policies WHERE tablename = 'intercompany_document_slots') AS policies FROM pg_class WHERE relname = 'intercompany_document_slots'")).rows[0];
    expect(slots).toEqual({ owner: 'migration_admin', relrowsecurity: true, relforcerowsecurity: true, policies: 1 });
    expect((await pool.query('SELECT * FROM app_pool_reach_violations()')).rows).toEqual([]);
  });

  it('app_user (any user, any claims, none) cannot lock, read or write it', async () => {
    const statements = [
      'SELECT 1 FROM intercompany_topology_lock FOR SHARE', 'SELECT 1 FROM intercompany_topology_lock FOR UPDATE', 'SELECT 1 FROM intercompany_topology_lock',
      'UPDATE intercompany_topology_lock SET id = id', 'DELETE FROM intercompany_topology_lock', 'LOCK TABLE intercompany_topology_lock IN ACCESS EXCLUSIVE MODE',
    ];
    for (const user of [U.x, U.a, U.ab]) {
      await asAppUser(pool, user, co.A, async (q) => {
        for (const text of statements) expect((await outcome(q, text)).slice(0, 5), `${user}: ${text}`).toBe('42501');
      });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      for (const text of statements) expect((await outcome(client, text)).slice(0, 5), `no claims: ${text}`).toBe('42501');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a session that holds the OLD public advisory key (session-level, until it disconnects) stalls nobody', async () => {
    const stranger = await pool.connect();
    const [low, high] = pairOf(co.A, co.B);
    const writer = await openSession(U.ab, low);
    try {
      const key = "pg_catalog.hashtextextended('isaflow.intercompany.group_topology', 0)";
      await stranger.query(`SELECT pg_catalog.pg_advisory_lock(${key})`);
      await writer.query("SET LOCAL lock_timeout = '2s'");
      const id = (await writer.query(`INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
        VALUES ($1, $2, 'group', 'active', $1) RETURNING id`, [low, high])).rows[0].id as string;
      expect(id).toBeTruthy();
      await writer.query('COMMIT');
      const t0 = Date.now();
      await pool.query(LEAVE, [co.G, co.B]);                     // the leave (superuser, as the trigger's table owner) is not stalled either
      expect(Date.now() - t0).toBeLessThan(2000);
      expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [id])).rows[0].status).toBe('revoked');
    } finally {
      await stranger.query('SELECT pg_catalog.pg_advisory_unlock_all()').catch(() => undefined);
      stranger.release();
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });
});

describe('one accepted target and one active link per company document, whatever the connection', () => {
  it('links: a replacement of a revoked pair cannot activate a company document that is already in an active link', async () => {
    const first = await plantConnection(pool, co.A, co.B);
    const [docA, docB] = [crypto.randomUUID(), crypto.randomUUID()];
    await plantLink(pool, first, { doc_a: docA, doc_b: docB, status: 'active' });
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [first]), true);
    const second = await plantConnection(pool, co.A, co.B);
    await expect(plantLink(pool, second, { doc_a: crypto.randomUUID(), doc_b: docB, status: 'active' })).rejects.toThrow(/intercompany_links_doc_b_active/);
    await expect(plantLink(pool, second, { doc_a: docA, doc_b: crypto.randomUUID(), status: 'active' })).rejects.toThrow(/intercompany_links_doc_a_active/);
    await plantLink(pool, second, { doc_a: crypto.randomUUID(), doc_b: crypto.randomUUID(), status: 'active' });          // other documents are fine
    await plantLink(pool, second, { doc_a: docA, doc_b: docB, status: 'unlinked' });                                      // and a non-active row holds no slot
  });

  it('the indexes are per company: their definitions carry no connection column', async () => {
    const defs = (await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('intercompany_links_doc_a_active', 'intercompany_links_doc_b_active', 'intercompany_messages_target_uq') ORDER BY 1`)).rows;
    expect(defs.map((d) => d.indexname)).toHaveLength(3);
    for (const d of defs) expect(d.indexdef, d.indexname).not.toMatch(/connection_id/);
    expect(defs.find((d) => d.indexname === 'intercompany_messages_target_uq').indexdef).toMatch(/\(to_company_id, target_doc_type, target_doc_id\)/);
    expect(defs.find((d) => d.indexname === 'intercompany_links_doc_a_active').indexdef).toMatch(/\(company_a_id, doc_a_type, doc_a_id\)/);
    expect(defs.find((d) => d.indexname === 'intercompany_links_doc_b_active').indexdef).toMatch(/\(company_b_id, doc_b_type, doc_b_id\)/);
  });
});

describe('1002 over duplicate data: it refuses, naming the rows, and changes nothing', () => {
  async function applyOver(setupDuplicates: (c: import('pg').PoolClient) => Promise<void>): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setupDuplicates(client);
      try {
        await client.query(MIGRATION);
        return 'applied';
      } catch (err) {
        return (err as Error).message;
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('two accepted messages that name one document of one company', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const [m1, m2] = [await plantMessage(pool, id, co.A, co.B, { kind: 'payment' }), await plantMessage(pool, id, co.A, co.B, { kind: 'payment' })];
    const tgt = crypto.randomUUID();
    const message = await applyOver(async (c) => {
      await c.query('DROP INDEX public.intercompany_messages_target_uq');
      await c.query('ALTER TABLE intercompany_messages DISABLE TRIGGER trg_intercompany_messages_guard');
      await c.query("UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'supplier_invoice', target_doc_id = $1 WHERE id = ANY($2)", [tgt, [m1, m2]]);
    });
    expect(message).toMatch(/^1002: cannot make accepted message targets unique per receiving company/);
    expect(message).toContain(tgt);
    expect(message).toContain(m1);
    expect(message).toContain(m2);
    // nothing was applied: the index is as it was
    expect((await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'intercompany_messages_target_uq'")).rows[0].indexdef).toMatch(/to_company_id/);
  });

  it.each([['doc_a'], ['doc_b']])('two active links that hold one document of one company (%s)', async (column) => {
    const id = await plantConnection(pool, co.A, co.B);
    const doc = crypto.randomUUID();
    const l1 = await plantLink(pool, id, { doc_a: crypto.randomUUID(), doc_b: crypto.randomUUID(), status: 'pending_confirmation' });
    const l2 = await plantLink(pool, id, { doc_a: crypto.randomUUID(), doc_b: crypto.randomUUID(), status: 'pending_confirmation' });
    const message = await applyOver(async (c) => {
      await c.query(`DROP INDEX public.intercompany_links_${column}_active`);
      await c.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_links_guard');
      await c.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_link_slots');
      await c.query(`UPDATE intercompany_document_links SET status = 'active', ${column}_id = $1 WHERE id = ANY($2)`, [doc, [l1, l2]]);
    });
    expect(message).toMatch(/^1002: cannot make link documents unique per company/);
    expect(message).toContain(doc);
    expect(message).toContain(l1);
    expect(message).toContain(l2);
  });

  it('without duplicates it applies (and again: the indexes are rebuilt, the rows untouched)', async () => {
    expect(await applyOver(async () => undefined)).toBe('applied');
  });
});
