/**
 * Intercompany (1002): one accepted message per target document per receiving company and one active link per company document
 * position, whatever the connection (per-company unique indexes), and 1002 refusing to be applied over duplicate data, naming the rows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, plantConnection, pairOf, plantLink, plantMessage, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
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
