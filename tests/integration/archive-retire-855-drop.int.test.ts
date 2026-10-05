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
 * checking the tables afterwards could never fail. Where every table is
 * already gone there is nothing to replay, so every case skips (visibly); if
 * 855 is recorded but a table still exists, the suite fails instead.
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

/** Runs `body` in a rolled-back transaction, with every archive table emptied first unless `empty` is false. */
async function inRolledBackTx<T>(body: (c: PoolClient) => Promise<T>, empty = true): Promise<T> {
  const c = await getPoolForTests().connect();
  try {
    await c.query('BEGIN');
    if (empty) for (const t of TABLES) await c.query(`DELETE FROM ${t}`);
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
  archive_runs: `INSERT INTO archive_runs (company_id, run_by, cutoff_date, status) VALUES ($1, 'u', '2019-01-01', 'completed')`,
};

describeIfDb('migration 855: drop the data-archiving tables', () => {
  let gone = false;
  beforeAll(async () => {
    const pool = getPoolForTests();
    const recorded = (await pool.query(
      `SELECT 1 FROM schema_migrations WHERE name = '855_retire_data_archiving.sql'`)).rowCount === 1;
    const left = (await pool.query(
      `SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'r' AND relname = ANY($1::text[])`, [TABLES])).rows[0].n;
    if (recorded && left > 0) throw new Error(`855 is recorded but ${left} archive table(s) still exist`);
    gone = left === 0;
  });
  beforeEach((ctx) => { if (gone) ctx.skip(); });

  it('lint: every statement sits inside the one DO block (so psql -f in autocommit cannot drop past a refusal)', () => {
    const sqlOnly = MIGRATION.split('\n').filter(l => !/^\s*(--|$)/.test(l)).join('\n');
    expect(sqlOnly.startsWith('DO $$')).toBe(true);
    expect(sqlOnly.trimEnd().endsWith('END $$;')).toBe(true);
    expect(sqlOnly.match(/\$\$/g)).toHaveLength(2);
  });

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

  /** A real user and company (audit_log.user_id references users), and one archive_runs row per status. */
  async function runs(c: PoolClient, statuses: string[]): Promise<{ company: string; ids: string[] }> {
    const company = await newCompany(c);
    const userId = randomUUID();
    await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [userId, `${userId}@r855.test`]);
    const ids: string[] = [];
    for (const status of statuses) {
      ids.push((await c.query(
        `INSERT INTO archive_runs (company_id, run_by, cutoff_date, status, error_message)
         VALUES ($1, $2, '2019-01-01', $3::text, 'R855 ' || $3::text) RETURNING id`, [company, userId, status])).rows[0].id as string);
    }
    return { company, ids };
  }

  it('copies failed runs to audit_log, then drops the tables (Hein, 2026-10-05)', async () => {
    await inRolledBackTx(async (c) => {
      const { company, ids } = await runs(c, ['failed', 'failed']);
      expect(await apply(c)).toBeNull();
      expect(await present(c)).toEqual([]);
      const logged = (await c.query(
        `SELECT entity_id, action, changes->>'status' AS status, changes->>'error_message' AS err
         FROM audit_log WHERE company_id = $1 AND entity_type = 'archive_run' ORDER BY entity_id`, [company])).rows;
      expect(logged).toEqual([...ids].sort().map(id => ({ entity_id: id, action: 'delete', status: 'failed', err: 'R855 failed' })));
    });
  });

  it.each(['completed', 'running', 'pending'])('still refuses on a %s run, after setting the failed ones aside', async (status) => {
    await inRolledBackTx(async (c) => {
      await runs(c, ['failed', status]);
      expect(await apply(c)).toMatch(/855: archive_runs has 1 row\(s\)\. Not dropping/);
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

  it('refuses, and does not CASCADE, when a view depends on an archive table', async () => {
    await inRolledBackTx(async (c) => {
      await c.query('CREATE VIEW archive_retire_855_v AS SELECT id FROM archive_customer_invoices');
      expect(await apply(c)).toMatch(/depend/);
    });
  });

  it.each([['lower case', 'archive_runs'], ['upper case', 'ARCHIVE_RUNS']])(
    'refuses when a plpgsql function names an archive table in %s (no dependency would stop the drop)', async (_c, name) => {
      await inRolledBackTx(async (c) => {
        await c.query(`CREATE FUNCTION archive_retire_855_f() RETURNS bigint LANGUAGE plpgsql
          AS $f$ BEGIN RETURN (SELECT count(*) FROM ${name}); END $f$`);
        expect(await apply(c)).toMatch(/855: function\(s\) archive_retire_855_f\(\) reference an archive table/);
      });
    });

  it('still refuses on such a function when standard_conforming_strings is off', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`CREATE FUNCTION archive_retire_855_f() RETURNS bigint LANGUAGE plpgsql
        AS $f$ BEGIN RETURN (SELECT count(*) FROM ARCHIVE_RUNS); END $f$`);
      await c.query('SET LOCAL standard_conforming_strings = off');
      expect(await apply(c)).toMatch(/855: function\(s\) archive_retire_855_f\(\) reference an archive table/);
    });
  });

  it('does not refuse on a function that only names a longer identifier (archive_runs_legacy)', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`CREATE FUNCTION archive_retire_855_g() RETURNS int LANGUAGE plpgsql
        AS $g$ BEGIN /* replaces archive_runs_legacy */ RETURN 1; END $g$`);
      expect(await apply(c)).toBeNull();
    });
  });

  it('gives up after its lock_timeout instead of waiting forever behind a writer', async () => {
    const pool = getPoolForTests();
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE archive_runs IN ROW EXCLUSIVE MODE'); // held, never committed
      const started = Date.now();
      const err = await inRolledBackTx(c => apply(c), false);
      expect(err).toMatch(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  }, 30_000);

  it('a row committed while the migration waits for its lock is counted, not dropped', async () => {
    const pool = getPoolForTests();
    const writer = await pool.connect();
    const company = randomUUID();
    // Precondition: a leftover row would make the refusal pass without the race.
    for (const tbl of TABLES) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${tbl}`)).rows[0].n, tbl).toBe(0);
    }
    try {
      // Cleanup if a killed run leaves these: DELETE FROM archive_customer_invoices WHERE company_id IN
      // (SELECT id FROM companies WHERE name = 'archive-retire-855-race'); then the companies rows.
      await writer.query(`INSERT INTO companies (id, name) VALUES ($1, 'archive-retire-855-race')`, [company]);
      await writer.query('BEGIN');
      await writer.query(SEEDS.archive_customer_invoices!, [company]);
      const result = inRolledBackTx(async (c) => {
        const pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
        const running = apply(c);
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS b', [pid])).rows[0].b;
          if (!blocked) await new Promise(r => setTimeout(r, 50));
        }
        expect(blocked).toBe(true); // the migration really waited on the writer
        await writer.query('COMMIT');
        return running;
      }, false);
      expect(await result).toMatch(/855: archive_customer_invoices has 1 row\(s\)/);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await pool.query('DELETE FROM archive_customer_invoices WHERE company_id = $1', [company]);
      await pool.query('DELETE FROM companies WHERE id = $1', [company]);
      writer.release();
    }
  });

  it('leaves row_security and lock_timeout as they were for the rest of the transaction', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`SET LOCAL lock_timeout = '7s'`); // non-defaults, so a hard-coded reset shows
      await c.query(`SET LOCAL row_security = off`);
      const before = (await c.query(`SELECT current_setting('row_security') rs, current_setting('lock_timeout') lt`)).rows[0];
      expect(await apply(c)).toBeNull();
      const after = (await c.query(`SELECT current_setting('row_security') rs, current_setting('lock_timeout') lt`)).rows[0];
      expect(after).toEqual(before);
    });
  });
});
