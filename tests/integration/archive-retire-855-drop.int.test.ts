/**
 * Migration 855 drops the five archive_* mirror tables and archive_runs
 * (archive redesign spec PR #641, D0 = retire), closing N1 (R-197):
 * archive_gl_journal_lines had no company_id, no RLS and full app_user DML.
 *
 * A non-empty table means someone must decide per run (spec D0a), so the
 * migration must refuse, not drop. Five of the six tables FORCE RLS, so a
 * role without BYPASSRLS would count 0 rows there and pass the guard
 * vacuously. The guard turns row_security off, which makes that role fail
 * outright instead: 855 can only be applied by a superuser or BYPASSRLS role.
 *
 * Each case replays the real file inside a transaction that is ROLLED BACK,
 * so the shared fixture schema is never left changed. A refusal is proven by
 * the error alone: ROLLBACK TO SAVEPOINT restores any partial drop, so
 * checking the tables afterwards could never fail. On a database where 855
 * is already recorded the tables are gone and there is nothing to replay, so
 * every case skips (visibly) there.
 */
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

/** Runs `body` in a rolled-back transaction, with every archive table emptied first. */
async function inRolledBackTx<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPoolForTests().connect();
  try {
    await c.query('BEGIN');
    for (const t of TABLES) await c.query(`DELETE FROM ${t}`);
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

async function newCompany(c: PoolClient): Promise<string> {
  const r = await c.query(
    `INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'archive-retire-855') RETURNING id`);
  return (r.rows[0] as { id: string }).id;
}

// One seed per table, inserted as the fixture superuser, so RLS does not filter the guard's count.
const SEEDS: Record<string, string> = {
  archive_gl_journal_entries: `INSERT INTO archive_gl_journal_entries (id, company_id, entry_date) VALUES (gen_random_uuid(), $1, '2018-03-01')`,
  archive_gl_journal_lines: `INSERT INTO archive_gl_journal_lines (id, journal_entry_id) VALUES (gen_random_uuid(), gen_random_uuid())`,
  archive_bank_transactions: `INSERT INTO archive_bank_transactions (id, company_id, transaction_date) VALUES (gen_random_uuid(), $1, '2018-03-01')`,
  archive_customer_invoices: `INSERT INTO archive_customer_invoices (id, company_id) VALUES (gen_random_uuid(), $1)`,
  archive_supplier_invoices: `INSERT INTO archive_supplier_invoices (id, company_id, invoice_date) VALUES (gen_random_uuid(), $1, '2018-03-01')`,
  archive_runs: `INSERT INTO archive_runs (company_id, run_by, cutoff_date, status) VALUES ($1, 'u', '2019-01-01', 'failed')`,
};

describeIfDb('migration 855: drop the data-archiving tables', () => {
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
      expect(await apply(c)).toBeNull();
      expect(await present(c)).toEqual([]);
    });
  });

  it.each(TABLES)('refuses when %s has a row', async (table) => {
    await inRolledBackTx(async (c) => {
      const company = await newCompany(c);
      const seed = SEEDS[table]!;
      // archive_runs.run_by references users and the fixture has none: skip FK checks for the seed only.
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(seed, seed.includes('$1') ? [company] : []);
      await c.query('SET LOCAL session_replication_role = origin');
      expect(await apply(c)).toMatch(new RegExp(`855: ${table} has 1 row\\(s\\)\\. Not dropping`));
    });
  });

  it('cannot be applied by an owner subject to RLS, even with every table empty', async () => {
    await inRolledBackTx(async (c) => {
      const role = `archive_retire_855_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await c.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      for (const t of TABLES) await c.query(`ALTER TABLE ${t} OWNER TO ${role}`);
      // Premise: as that owner, a row in a FORCE-RLS table counts as 0, so a plain count would pass.
      const company = await newCompany(c);
      await c.query(SEEDS.archive_customer_invoices!, [company]);
      await c.query(`SET LOCAL ROLE ${role}`);
      const seen = await c.query('SELECT count(*)::int AS n FROM archive_customer_invoices');
      expect((seen.rows[0] as { n: number }).n).toBe(0);
      await c.query('RESET ROLE');
      await c.query('DELETE FROM archive_customer_invoices');
      await c.query(`SET LOCAL ROLE ${role}`);
      expect(await apply(c)).toMatch(/row-level security/);
    });
  });

  it('leaves row_security and lock_timeout as they were for the rest of the transaction', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`SET LOCAL lock_timeout = '7s'`); // non-defaults, so a hard-coded reset shows
      await c.query(`SET LOCAL row_security = on`);
      const before = (await c.query(`SELECT current_setting('row_security') rs, current_setting('lock_timeout') lt`)).rows[0];
      expect(await apply(c)).toBeNull();
      const after = (await c.query(`SELECT current_setting('row_security') rs, current_setting('lock_timeout') lt`)).rows[0];
      expect(after).toEqual(before);
    });
  });
});
