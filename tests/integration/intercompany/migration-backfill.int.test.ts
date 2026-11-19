/**
 * Intercompany (1002): the two backfills (a lock row for every company, the slots of existing links) run as migration_admin, which
 * owns the tables, so the role that applies the migration (not a superuser, and in PG16 a member of migration_admin without
 * INHERIT) need not be able to write them. Proved with a session authorised as such a role. And the triggers that make lock rows
 * are ENABLE (origin), so a restore in replica mode (pg_restore --disable-triggers) skips them and the restored lock table cannot
 * collide with rows they would have made.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cleanup, co, outcome, plantConnection, plantDocument, setup, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const MIGRATION = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1002_intercompany_round2.sql'), 'utf8');
const ROLE = 'ic_probe_deploy';
const slice = (table: string) => {
  // the line before the first INSERT is whatever sets the role (it must be the switch to migration_admin: the test then runs it)
  const m = MIGRATION.match(new RegExp(`[^\\n]*\\nINSERT INTO public\\.${table}[\\s\\S]*?RESET ROLE;`));
  if (!m) throw new Error(`no backfill of ${table} found in 1002`);
  return m[0];
};

beforeAll(async () => {
  await setup(pool);
  await pool.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await pool.query(`CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await pool.query(`GRANT migration_admin TO ${ROLE} WITH INHERIT FALSE, SET TRUE`);
}, 60000);
afterAll(async () => {
  await wipeConnections(pool);
  await pool.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
  await cleanup(pool);
});

describe('the backfills run as migration_admin', () => {
  it('the deploy-like role cannot write either table itself (the probe is meaningful), but the backfills, which switch role, work', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const [docA, docB] = [await plantDocument(pool, 'customer_invoice', co.A), await plantDocument(pool, 'supplier_invoice', co.B)];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // an active link planted the way 1000 could have left one: no slot yet
      await client.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_links_guard');
      await client.query('ALTER TABLE intercompany_document_links DISABLE TRIGGER trg_intercompany_link_slots');
      const [low, high] = [co.A, co.B].sort();
      await client.query(
        `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, confirmed_by_a, confirmed_by_b, created_by)
         VALUES ($1, $2, 'customer_invoice', $3, $4, 'supplier_invoice', $5, 'manual_pairing', 'active', 'x', 'x', 'x')`, [id, low, docA, high, docB]);
      await client.query('ALTER TABLE intercompany_document_links ENABLE ALWAYS TRIGGER trg_intercompany_links_guard');
      await client.query('ALTER TABLE intercompany_document_links ENABLE ALWAYS TRIGGER trg_intercompany_link_slots');
      await client.query('DELETE FROM intercompany_company_locks');
      await client.query('DELETE FROM intercompany_document_slots');
      await client.query(`SET LOCAL SESSION AUTHORIZATION ${ROLE}`);
      expect((await outcome(client, 'INSERT INTO intercompany_company_locks(company_id) SELECT id FROM companies')).slice(0, 5)).toBe('42501');
      expect((await outcome(client, 'INSERT INTO intercompany_document_slots(company_id, doc_type, doc_id, link_id) SELECT company_a_id, doc_a_type, doc_a_id, id FROM intercompany_document_links')).slice(0, 5)).toBe('42501');
      await client.query(slice('intercompany_company_locks'));
      await client.query(slice('intercompany_document_slots'));
      await client.query('RESET SESSION AUTHORIZATION');
      const missing = (await client.query('SELECT count(*)::int AS n FROM companies c WHERE NOT EXISTS (SELECT 1 FROM intercompany_company_locks l WHERE l.company_id = c.id)')).rows[0].n;
      expect(missing).toBe(0);
      expect((await client.query('SELECT doc_id FROM intercompany_document_slots ORDER BY doc_id')).rows.map((r) => r.doc_id)).toEqual([docA, docB].sort());
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('a restore in replica mode', () => {
  it('the lock-row trigger and the join triggers are origin-only, so they do not run in replica mode; the changers are ALWAYS', async () => {
    const t = (await pool.query(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1) AND NOT tgisinternal ORDER BY tgname`,
      [['trg_intercompany_company_lock_row', 'trg_intercompany_group_joined', 'trg_intercompany_group_rejoined', 'trg_intercompany_group_membership', 'trg_intercompany_group_member_deleted', 'trg_intercompany_group_deactivated', 'trg_intercompany_group_removed']])).rows;
    expect(Object.fromEntries(t.map((r) => [r.tgname, r.tgenabled]))).toEqual({
      trg_intercompany_company_lock_row: 'O', trg_intercompany_group_joined: 'O', trg_intercompany_group_rejoined: 'O',
      trg_intercompany_group_membership: 'A', trg_intercompany_group_member_deleted: 'A', trg_intercompany_group_deactivated: 'A', trg_intercompany_group_removed: 'A',
    });
  });

  it('a company inserted and a member joined in replica mode make no lock row, so restoring the lock table afterwards cannot collide', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const id = crypto.randomUUID();
      await client.query("INSERT INTO companies(id, name) VALUES ($1, 'IC replica restore')", [id]);
      await client.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2)', [co.H, id]);
      expect((await client.query('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [id])).rows[0].n).toBe(0);
      await client.query('INSERT INTO intercompany_company_locks(company_id) VALUES ($1)', [id]);       // what the restore of the lock table does
      expect((await client.query('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [id])).rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('in origin mode the same company insert does make its row (the trigger works), and inserting it twice is harmless', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = crypto.randomUUID();
      await client.query("INSERT INTO companies(id, name) VALUES ($1, 'IC origin company')", [id]);
      expect((await client.query('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [id])).rows[0].n).toBe(1);
      await client.query('INSERT INTO intercompany_company_locks(company_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
