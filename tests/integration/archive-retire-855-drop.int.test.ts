/**
 * Migration 855 retires physical archiving (archive-redesign spec, D0 = A):
 * it drops the five archive_* mirror tables and archive_runs, and closes N1
 * (archive_gl_journal_lines had no company_id, no RLS and full app_user DML).
 *
 * A non-empty table means history already left the live ledger (spec D0a):
 * the migration must refuse, not drop it. Five of the six tables have FORCE
 * RLS, so a migration role without BYPASSRLS would count 0 rows there and
 * pass the guard vacuously. The guard turns row_security off, which makes
 * that case an error instead of a filtered count; the last case pins it.
 *
 * Each case replays the real file inside a transaction that is ROLLED BACK,
 * so the shared fixture schema is never left changed. On a database where 855
 * is already recorded the tables are gone and there is nothing to replay, so
 * every case skips (visibly) there.
 */
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { getPoolForTests } from '@/lib/neon';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(process.cwd(), 'scripts/migrations/sql/855_retire_data_archiving.sql'), 'utf8');

const TABLES = [
  'archive_gl_journal_entries', 'archive_gl_journal_lines', 'archive_bank_transactions',
  'archive_customer_invoices', 'archive_supplier_invoices', 'archive_runs',
];

async function present(c: PoolClient): Promise<string[]> {
  const r = await c.query(
    `SELECT relname FROM pg_class WHERE relkind = 'r' AND relname = ANY($1::text[]) ORDER BY 1`, [TABLES]);
  return r.rows.map((row: { relname: string }) => row.relname);
}

/** Runs `body` in a rolled-back transaction. */
async function inRolledBackTx<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPoolForTests().connect();
  try {
    await c.query('BEGIN');
    return await body(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Applies the migration under a savepoint; returns the error message, or null. */
async function apply(c: PoolClient): Promise<string | null> {
  await c.query('SAVEPOINT m855');
  try {
    await c.query(MIGRATION);
    await c.query('RELEASE SAVEPOINT m855');
    return null;
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT m855');
    return (err as Error).message;
  }
}

async function anyCompany(c: PoolClient): Promise<string> {
  const r = await c.query(
    `INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'archive-retire-855') RETURNING id`);
  return (r.rows[0] as { id: string }).id;
}

describeIfDb('migration 855: retire data archiving', () => {
  let applied = false;
  beforeAll(async () => {
    const r = await getPoolForTests().query(
      `SELECT 1 FROM schema_migrations WHERE name = '855_retire_data_archiving.sql'`);
    applied = r.rowCount === 1;
  });
  beforeEach((ctx) => { if (applied) ctx.skip(); });

  it('drops all six archive tables when every one is empty', async () => {
    await inRolledBackTx(async (c) => {
      expect(await present(c)).toEqual([...TABLES].sort());
      for (const t of TABLES) await c.query(`DELETE FROM ${t}`);
      expect(await apply(c)).toBeNull();
      expect(await present(c)).toEqual([]);
    });
  });

  // One seed per table. Run as the fixture superuser, so RLS does not filter the guard's count here.
  const SEEDS: Record<string, string> = {
    archive_gl_journal_entries: `INSERT INTO archive_gl_journal_entries (id, company_id, entry_date) VALUES (gen_random_uuid(), $1, '2018-03-01')`,
    archive_gl_journal_lines: `INSERT INTO archive_gl_journal_lines (id, journal_entry_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
    archive_bank_transactions: `INSERT INTO archive_bank_transactions (id, company_id, transaction_date) VALUES (gen_random_uuid(), $1, '2018-03-01')`,
    archive_customer_invoices: `INSERT INTO archive_customer_invoices (id, company_id) VALUES (gen_random_uuid(), $1)`,
    archive_supplier_invoices: `INSERT INTO archive_supplier_invoices (id, company_id, invoice_date) VALUES (gen_random_uuid(), $1, '2018-03-01')`,
    archive_runs: `INSERT INTO archive_runs (company_id, run_by, cutoff_date, status) VALUES ($1, 'u', '2019-01-01', 'failed')`,
  };

  it.each(TABLES)('refuses, and drops nothing, when %s has a row', async (table) => {
    await inRolledBackTx(async (c) => {
      for (const t of TABLES) await c.query(`DELETE FROM ${t}`);
      const company = await anyCompany(c);
      const seed = SEEDS[table]!;
      // archive_runs.run_by references users and the fixture has none: skip FK checks for the seed only.
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(seed, seed.includes('$1') ? [company] : []);
      await c.query('SET LOCAL session_replication_role = origin');
      expect(await apply(c)).toMatch(new RegExp(`${table} has 1 row`));
      expect(await present(c)).toEqual([...TABLES].sort());
    });
  });

  it('a FORCE-RLS table with a row cannot pass the guard as an owner without BYPASSRLS', async () => {
    await inRolledBackTx(async (c) => {
      for (const t of TABLES) await c.query(`DELETE FROM ${t}`);
      const company = await anyCompany(c);
      await c.query(
        `INSERT INTO archive_customer_invoices (id, company_id, invoice_number) VALUES (gen_random_uuid(), $1, 'R-855')`,
        [company]);
      // Premise: the table forces RLS, and the owner role below is subject to it.
      const forced = await c.query(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'archive_customer_invoices'`);
      expect((forced.rows[0] as { relforcerowsecurity: boolean }).relforcerowsecurity).toBe(true);
      await c.query('CREATE ROLE archive_retire_855_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
      for (const t of TABLES) await c.query(`ALTER TABLE ${t} OWNER TO archive_retire_855_owner`);
      await c.query('SET LOCAL ROLE archive_retire_855_owner');
      const seen = await c.query('SELECT count(*)::int AS n FROM archive_customer_invoices');
      expect((seen.rows[0] as { n: number }).n).toBe(0); // the vacuous count the guard must not trust
      expect(await apply(c)).toMatch(/row-level security/);
      await c.query('RESET ROLE');
      expect(await present(c)).toEqual([...TABLES].sort());
    });
  });
});
