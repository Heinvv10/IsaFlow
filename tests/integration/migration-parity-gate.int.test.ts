/**
 * Drives the pre-deploy parity gate (scripts/lib/migrationParityRun.ts) against
 * two REAL databases named `isaflow` (prod stand-in) and `isaflow_dev` on a
 * disposable Postgres. Skips unless PARITY_TEST_PG_URL is set.
 *
 * Run (with PW set to any throwaway password; the container must be yours, on a port `ss -ltn` shows free):
 *   docker run -d --name parity-test-pg -e POSTGRES_PASSWORD=$PW -p 127.0.0.1:<port>:5432 postgres:16
 *   PARITY_TEST_PG_URL=<loopback URL of that container, database postgres, sslmode off> \
 *     node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/migration-parity-gate.int.test.ts
 *   docker rm -f parity-test-pg
 *
 * The URL must be loopback; the test DROPs and recreates databases `isaflow` and `isaflow_dev`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { computeChecksum, type MigrationFile } from '../../scripts/lib/migrationFiles';
import { runParityGate, MAX_DEV_APPLY } from '../../scripts/lib/migrationParityRun';
import { HISTORIC_DEV_UNTRACKED } from '../../scripts/lib/migrationParity';

const BASE = process.env.PARITY_TEST_PG_URL;
const suite = BASE ? describe : describe.skip;
const urlFor = (db: string): string => { const u = new URL(BASE!); u.pathname = `/${db}`; u.searchParams.set('sslmode', 'disable'); return u.toString(); };

const mf = (name: string, content: string): MigrationFile => ({
  name, content, version: /^(\d+[a-z]?)_/.exec(name)![1]!, checksum: computeChecksum(content),
});
const create = (t: string): string => `CREATE TABLE ${t}(id int); INSERT INTO order_log(t) VALUES ('${t}');`;
const A = mf('870_a.sql', create('t_a'));
const B = mf('871_b.sql', create('t_b'));
const C = mf('872_c.sql', create('t_c'));
const BAD = mf('872_c.sql', 'CREATE TABLE t_c(id int); SELECT 1/0;');
const D = mf('873_d.sql', create('t_d'));

async function withDb<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const track = (c: pg.Client, ...fs: MigrationFile[]) =>
  Promise.all(fs.map((f) => c.query('INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)', [f.version, f.name, f.checksum])));
const reset = (db: string) => withDb(db, async (c) => {
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, version text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)');
  await c.query('CREATE TABLE order_log(n serial PRIMARY KEY, t text)');
});
const tables = (db: string) => withDb(db, async (c) => (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 't\\_%'")).rows.map((r) => r.tablename as string).sort());
const trackedNames = (db: string) => withDb(db, async (c) => (await c.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name as string));

const out: string[] = [];
const gate = (files: MigrationFile[], over: Partial<Parameters<typeof runParityGate>[0]> = {}) =>
  runParityGate({ devUrl: urlFor('isaflow_dev'), prodUrl: urlFor('isaflow'), files, applyDev: false,
    say: (l) => out.push(l), warn: (l) => out.push(l), ...over });

suite('migration parity gate (real databases)', () => {
  beforeAll(async () => {
    const host = new URL(BASE!).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('PARITY_TEST_PG_URL must be loopback');
    const admin = new pg.Client({ connectionString: BASE });
    await admin.connect();
    for (const db of ['isaflow', 'isaflow_dev']) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${db}`);
    }
    await admin.end();
  });
  beforeEach(async () => { out.length = 0; await reset('isaflow'); await reset('isaflow_dev'); });
  afterAll(() => undefined);

  const seed = async (prod: MigrationFile[], dev: MigrationFile[]) => {
    await withDb('isaflow', (c) => track(c, ...prod));
    await withDb('isaflow_dev', (c) => track(c, ...dev));
  };

  it('passes when dev and prod agree', async () => {
    await seed([A], [A]);
    expect(await gate([A])).toBe(0);
  });

  it('opens prod read-only: a write behind the SELECT fails and leaves no trace', async () => {
    await withDb('isaflow', async (c) => {
      await c.query('CREATE TABLE audit(x int)');
      await c.query(`CREATE FUNCTION sm() RETURNS TABLE(name text, checksum text) LANGUAGE plpgsql VOLATILE AS $$
        BEGIN INSERT INTO audit VALUES (1); RETURN QUERY SELECT 'x'::text, 'y'::text; END $$`);
      await c.query('DROP TABLE schema_migrations; CREATE VIEW schema_migrations AS SELECT * FROM sm()');
    });
    await expect(gate([A])).rejects.toThrow(/read-only transaction/);
    expect((await withDb('isaflow', (c) => c.query('SELECT count(*)::int AS n FROM audit'))).rows[0].n).toBe(0);
  });

  describe('identity', () => {
    it('refuses a prod URL that names another database', async () => {
      await seed([A], [A]);
      await expect(gate([A], { prodUrl: urlFor('isaflow_dev') })).rejects.toThrow(/expected "isaflow"/);
    });
    it('refuses a dev URL that names the production database', async () => {
      await seed([A], [A]);
      await expect(gate([A], { devUrl: urlFor('isaflow') })).rejects.toThrow(/expected "isaflow_dev"/);
    });
    it('refuses an empty prod', async () => {
      await withDb('isaflow_dev', (c) => track(c, A));
      await expect(gate([A], { applyDev: true })).rejects.toThrow(/empty/);
      expect(await tables('isaflow_dev')).toEqual([]);
    });
    it('refuses when both connections resolve to the same server and database, whatever the URL strings', async () => {
      await seed([A], [A]);
      await expect(
        gate([A], { devUrl: `${urlFor('isaflow')}&application_name=x`, prodUrl: urlFor('isaflow'), expect: { dev: 'isaflow', prod: 'isaflow' } })
      ).rejects.toThrow(/same server and database/);
    });
  });

  describe('--apply-dev', () => {
    it('applies only pending files missing on dev, in order, with tracking rows; never touches prod', async () => {
      const old = mf([...HISTORIC_DEV_UNTRACKED][0]!, create('t_old'));
      await seed([A, old], [A]);
      expect(await gate([A, old, C, B], { applyDev: true })).toBe(0);
      expect(await tables('isaflow_dev')).toEqual(['t_b', 't_c']);
      expect(await trackedNames('isaflow_dev')).toEqual(['870_a.sql', '871_b.sql', '872_c.sql']);
      const order = await withDb('isaflow_dev', async (c) => (await c.query('SELECT t FROM order_log ORDER BY n')).rows.map((r) => r.t));
      expect(order).toEqual(['t_b', 't_c']);
      expect(await trackedNames('isaflow')).toEqual(['870_a.sql', old.name].sort());
      expect(await tables('isaflow')).toEqual([]);
    });

    it('stops at the first failure: the failing file rolls back fully and later files are untouched', async () => {
      await seed([A], [A]);
      expect(await gate([A, B, BAD, D], { applyDev: true })).toBe(1);
      expect(await tables('isaflow_dev')).toEqual(['t_b']);
      expect(await trackedNames('isaflow_dev')).toEqual(['870_a.sql', '871_b.sql']);
      expect(out.join('\n')).toMatch(/dev failed applying 872_c\.sql/);
    });

    it('applies nothing while any FAIL exists', async () => {
      await withDb('isaflow', (c) => track(c, A));
      await withDb('isaflow_dev', (c) => c.query("INSERT INTO schema_migrations(version,name,checksum) VALUES ('870','870_a.sql','edited')"));
      expect(await gate([A, B], { applyDev: true })).toBe(1);
      expect(await tables('isaflow_dev')).toEqual([]);
    });

    it(`refuses more than ${MAX_DEV_APPLY} files`, async () => {
      await seed([A], [A]);
      const many = Array.from({ length: MAX_DEV_APPLY + 1 }, (_, i) => mf(`9${String(i).padStart(2, '0')}_m${i}.sql`, create(`t_m${i}`)));
      await expect(gate([A, ...many], { applyDev: true })).rejects.toThrow(/cap/);
      expect(await tables('isaflow_dev')).toEqual([]);
    });

    it('takes the runner advisory lock: a held lock blocks it (bounded by the statement timeout)', async () => {
      await seed([A], [A]);
      await withDb('isaflow_dev', async (holder) => {
        await holder.query('SELECT pg_advisory_lock(73014132)');
        await expect(gate([A, B], { applyDev: true, statementTimeoutMs: 800 })).rejects.toThrow(/statement timeout/);
        expect(await gate([A, B], { applyDev: false })).toBe(1); // read-only mode takes no lock
      });
      expect(await tables('isaflow_dev')).toEqual([]);
    });

    it('re-reads dev under the lock and skips a file another runner applied meanwhile', async () => {
      await seed([A], [A]);
      const holder = new pg.Client({ connectionString: urlFor('isaflow_dev') });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock(73014132)');
      const run = gate([A, B, C], { applyDev: true });
      for (let i = 0; i < 50; i++) {
        const w = await holder.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted");
        if (w.rowCount) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await holder.query(B.content);
      await track(holder, B);
      await holder.query('SELECT pg_advisory_unlock(73014132)');
      await holder.end();
      expect(await run).toBe(0);
      expect(await tables('isaflow_dev')).toEqual(['t_b', 't_c']);
      const order = await withDb('isaflow_dev', async (c) => (await c.query('SELECT t FROM order_log ORDER BY n')).rows.map((r) => r.t));
      expect(order).toEqual(['t_b', 't_c']);
    });
  });

  describe('historic ignore list is bounded', () => {
    it('ignores a frozen name but fails any other prod-but-not-dev file, even with --apply-dev', async () => {
      const listed = mf([...HISTORIC_DEV_UNTRACKED][0]!, create('t_old'));
      await seed([A, listed], [A]);
      expect(await gate([A, listed])).toBe(0);
      const fresh = mf('875_new.sql', create('t_new'));
      await withDb('isaflow', (c) => track(c, fresh));
      expect(await gate([A, listed, fresh], { applyDev: true })).toBe(1);
      expect(out.join('\n')).toMatch(/DEV_MISSING_APPLIED_ON_PROD/);
      expect(await tables('isaflow_dev')).toEqual([]);
    });
  });
});
