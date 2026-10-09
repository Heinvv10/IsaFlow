/**
 * Drives the pre-deploy parity gate (scripts/lib/migrationParityRun.ts) against
 * two REAL databases named `isaflow` (prod stand-in) and `isaflow_dev` on a
 * disposable Postgres. Skips unless PARITY_TEST_PG_URL is set.
 *
 * Real database NAMES `isaflow` / `isaflow_dev` are NEVER created, dropped or touched: the
 * real-database tests use throwaway parity_prod_t / parity_dev_t through the `expect` override.
 * The default-name refusal tests only connect to those throwaways and assert they are refused.
 *
 * Run it on any change to scripts/lib/migrationParityRun.ts (ci does not run it). Start your own
 * Postgres on a free loopback port (`ss -ltn` first), never one of 7770-7776:
 *   docker run -d --name parity-test-pg -e POSTGRES_PASSWORD=<throwaway> -p 127.0.0.1:<port>:5432 postgres:16
 *   PARITY_TEST_PG_DISPOSABLE=1 PARITY_TEST_PG_URL=<loopback URL of that container, database postgres, sslmode off> \
 *     node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/migration-parity-gate.int.test.ts
 *   docker rm -f parity-test-pg
 * Optional PARITY_TEST_PG_URL_2 (a second container) enables the cross-cluster test.
 * tests/helpers/parityTestGuard.ts refuses (before connecting) anything that is not a loopback throwaway.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertOnlyThrowawayDatabases, assertParityTestUrl } from '../helpers/parityTestGuard';
import { computeChecksum, type MigrationFile } from '../../scripts/lib/migrationFiles';
import { runParityGate, MAX_DEV_APPLY } from '../../scripts/lib/migrationParityRun';
import { HISTORIC_DEV_UNTRACKED } from '../../scripts/lib/migrationParity';

const BASE = process.env.PARITY_TEST_PG_URL;
const BASE2 = process.env.PARITY_TEST_PG_URL_2;
const suite = BASE ? describe : describe.skip;
const PROD = 'parity_prod_t';
const DEV = 'parity_dev_t';
const RO_ROLE = 'parity_ro_t';
const RO_PW = randomUUID();
const urlOn = (base: string, db: string, role?: string): string => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  u.searchParams.set('sslmode', 'disable');
  if (role) { u.username = role; u.password = RO_PW; }
  return u.toString();
};
const urlFor = (db: string, role?: string): string => urlOn(BASE!, db, role);

const mf = (name: string, content: string): MigrationFile => ({
  name, content, version: /^(\d+[a-z]?)_/.exec(name)![1]!, checksum: computeChecksum(content),
});
const create = (t: string): string => `CREATE TABLE ${t}(id int); INSERT INTO order_log(t) VALUES ('${t}');`;
const A = mf('870_a.sql', create('t_a'));
const B = mf('871_b.sql', create('t_b'));
const C = mf('872_c.sql', create('t_c'));
const BAD = mf('872_c.sql', 'CREATE TABLE t_c(id int); SELECT 1/0;');
const D = mf('873_d.sql', create('t_d'));

async function withDb<T>(db: string, fn: (c: pg.Client) => Promise<T>, base: string = BASE!): Promise<T> {
  const c = new pg.Client({ connectionString: urlOn(base, db) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const track = (c: pg.Client, ...fs: MigrationFile[]) =>
  Promise.all(fs.map((f) => c.query('INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)', [f.version, f.name, f.checksum])));
const reset = (db: string, base: string = BASE!) => withDb(db, async (c) => {
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, version text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)');
  await c.query('CREATE TABLE order_log(n serial PRIMARY KEY, t text)');
  await c.query(`GRANT USAGE ON SCHEMA public TO ${RO_ROLE}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RO_ROLE}`);
}, base);
const tables = (db: string) => withDb(db, async (c) => (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 't\\_%'")).rows.map((r) => r.tablename as string).sort());
const trackedNames = (db: string) => withDb(db, async (c) => (await c.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name as string));

const out: string[] = [];
const gate = (files: MigrationFile[], over: Partial<Parameters<typeof runParityGate>[0]> = {}) =>
  runParityGate({ devUrl: urlFor(DEV), prodUrl: urlFor(PROD), files, applyDev: false, expect: { dev: DEV, prod: PROD },
    say: (l) => out.push(l), warn: (l) => out.push(l), ...over });

suite('migration parity gate (real databases)', () => {
  const requested = [BASE!, ...(BASE2 ? [BASE2] : [])];
  // Only clusters that passed BOTH the URL guard and the server-side database check; afterAll touches nothing else.
  const clusters: string[] = [];
  beforeAll(async () => {
    for (const base of requested) {
      assertParityTestUrl(base, process.env); // throws before any connection if this is not a throwaway
      const admin = new pg.Client({ connectionString: base });
      await admin.connect();
      try {
        assertOnlyThrowawayDatabases((await admin.query('SELECT datname FROM pg_database')).rows.map((r) => r.datname as string));
        clusters.push(base);
        for (const db of [PROD, DEV]) {
          await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
          await admin.query(`CREATE DATABASE ${db}`);
        }
        await admin.query(`DROP ROLE IF EXISTS ${RO_ROLE}`);
        await admin.query(`CREATE ROLE ${RO_ROLE} LOGIN PASSWORD '${RO_PW}'`);
      } finally {
        await admin.end();
      }
    }
  });
  beforeEach(async () => {
    out.length = 0;
    await reset(PROD);
    await reset(DEV);
    if (BASE2) await reset(PROD, BASE2);
  });
  afterAll(async () => {
    for (const base of clusters) {
      const admin = new pg.Client({ connectionString: base });
      await admin.connect();
      for (const db of [PROD, DEV]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${RO_ROLE}`);
      await admin.end();
    }
  });

  const seed = async (prod: MigrationFile[], dev: MigrationFile[]) => {
    await withDb(PROD, (c) => track(c, ...prod));
    await withDb(DEV, (c) => track(c, ...dev));
  };

  it('passes when dev and prod agree', async () => {
    await seed([A], [A]);
    expect(await gate([A])).toBe(0);
  });

  it('opens prod read-only: a write behind the SELECT fails and leaves no trace', async () => {
    await withDb(PROD, async (c) => {
      await c.query('CREATE TABLE audit(x int)');
      await c.query(`CREATE FUNCTION sm() RETURNS TABLE(name text, checksum text) LANGUAGE plpgsql VOLATILE AS $$
        BEGIN INSERT INTO audit VALUES (1); RETURN QUERY SELECT 'x'::text, 'y'::text; END $$`);
      await c.query('DROP TABLE schema_migrations; CREATE VIEW schema_migrations AS SELECT * FROM sm()');
    });
    await expect(gate([A])).rejects.toThrow(/read-only transaction/);
    expect((await withDb(PROD, (c) => c.query('SELECT count(*)::int AS n FROM audit'))).rows[0].n).toBe(0);
  });

  describe('identity (the real names are only ever EXPECTED here, never created)', () => {
    const REAL = { dev: 'isaflow_dev', prod: 'isaflow' };
    it('refuses a prod URL whose database is not `isaflow`', async () => {
      await seed([A], [A]);
      await expect(gate([A], { expect: REAL })).rejects.toThrow(/expected "isaflow"/);
    });
    it('refuses a dev URL whose database is not `isaflow_dev`', async () => {
      await seed([A], [A]);
      await expect(gate([A], { expect: { dev: 'isaflow_dev', prod: PROD } })).rejects.toThrow(/expected "isaflow_dev"/);
    });
    it('refuses an empty prod', async () => {
      await withDb(DEV, (c) => track(c, A));
      await expect(gate([A], { applyDev: true })).rejects.toThrow(/empty/);
      expect(await tables(DEV)).toEqual([]);
    });
    it('refuses when both connections are the same cluster and database, whatever the URL strings', async () => {
      await seed([A], [A]);
      await expect(
        gate([A], { devUrl: `${urlFor(PROD)}&application_name=x`, prodUrl: urlFor(PROD), expect: { dev: PROD, prod: PROD } })
      ).rejects.toThrow(/same cluster and database/);
      expect(out.join('\n')).not.toMatch(/cannot call pg_control_system/); // superuser: real system_identifier compared
    });
    it('falls back to server addr+port, says so, and still refuses, when the role cannot call pg_control_system', async () => {
      await withDb(PROD, (c) => c.query('REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC'));
      await seed([A], [A]);
      await expect(
        gate([A], { devUrl: urlFor(PROD, RO_ROLE), prodUrl: urlFor(PROD, RO_ROLE), expect: { dev: PROD, prod: PROD } })
      ).rejects.toThrow(/same cluster and database/);
      expect(out.join('\n')).toMatch(/cannot call pg_control_system/);
    });
    it.skipIf(!BASE2)('allows the same database name on a DIFFERENT cluster (the old name-only comparison would refuse)', async () => {
      await withDb(PROD, (c) => track(c, A));
      await withDb(PROD, (c) => track(c, A), BASE2!);
      expect(await gate([A], { devUrl: urlOn(BASE2!, PROD), expect: { dev: PROD, prod: PROD } })).toBe(0);
    });
  });

  describe('--apply-dev', () => {
    it('applies only pending files missing on dev, in order, with tracking rows; never touches prod', async () => {
      const old = mf([...HISTORIC_DEV_UNTRACKED][0]!, create('t_old'));
      await seed([A, old], [A]);
      expect(await gate([A, old, C, B], { applyDev: true })).toBe(0);
      expect(await tables(DEV)).toEqual(['t_b', 't_c']);
      expect(await trackedNames(DEV)).toEqual(['870_a.sql', '871_b.sql', '872_c.sql']);
      const order = await withDb(DEV, async (c) => (await c.query('SELECT t FROM order_log ORDER BY n')).rows.map((r) => r.t));
      expect(order).toEqual(['t_b', 't_c']);
      expect(await trackedNames(PROD)).toEqual(['870_a.sql', old.name].sort());
      expect(await tables(PROD)).toEqual([]);
    });

    it('runs each migration under the 15-minute apply bound (not the 60s read bound, not unbounded)', async () => {
      await seed([A], [A]);
      const probe = mf('871_probe.sql', "INSERT INTO order_log(t) SELECT current_setting('statement_timeout');");
      expect(await gate([A, probe], { applyDev: true })).toBe(0);
      const rows = await withDb(DEV, async (c) => (await c.query('SELECT t FROM order_log')).rows.map((r) => r.t));
      expect(rows).toEqual(['15min']);
    });

    it('stops at the first failure: the failing file rolls back fully and later files are untouched', async () => {
      await seed([A], [A]);
      expect(await gate([A, B, BAD, D], { applyDev: true })).toBe(1);
      expect(await tables(DEV)).toEqual(['t_b']);
      expect(await trackedNames(DEV)).toEqual(['870_a.sql', '871_b.sql']);
      expect(out.join('\n')).toMatch(/dev failed applying 872_c\.sql/);
    });

    it('applies nothing while any FAIL exists', async () => {
      await withDb(PROD, (c) => track(c, A));
      await withDb(DEV, (c) => c.query("INSERT INTO schema_migrations(version,name,checksum) VALUES ('870','870_a.sql','edited')"));
      expect(await gate([A, B], { applyDev: true })).toBe(1);
      expect(await tables(DEV)).toEqual([]);
    });

    it(`refuses more than ${MAX_DEV_APPLY} files`, async () => {
      await seed([A], [A]);
      const many = Array.from({ length: MAX_DEV_APPLY + 1 }, (_, i) => mf(`9${String(i).padStart(2, '0')}_m${i}.sql`, create(`t_m${i}`)));
      await expect(gate([A, ...many], { applyDev: true })).rejects.toThrow(/cap/);
      expect(await tables(DEV)).toEqual([]);
    });

    it('takes the runner advisory lock: a held lock blocks it (bounded by the statement timeout)', async () => {
      await seed([A], [A]);
      await withDb(DEV, async (holder) => {
        await holder.query('SELECT pg_advisory_lock(73014132)');
        await expect(gate([A, B], { applyDev: true, statementTimeoutMs: 800 })).rejects.toThrow(/statement timeout/);
        expect(await gate([A, B], { applyDev: false })).toBe(1); // read-only mode takes no lock
      });
      expect(await tables(DEV)).toEqual([]);
    });

    it('re-reads dev under the lock and skips a file another runner applied meanwhile', async () => {
      await seed([A], [A]);
      const holder = new pg.Client({ connectionString: urlFor(DEV) });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock(73014132)');
      const run = gate([A, B, C], { applyDev: true });
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = ((await holder.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rowCount ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 100));
      }
      expect(waiting, 'the gate never queued on the advisory lock, so the ordering below proves nothing').toBe(true);
      await holder.query(B.content);
      await track(holder, B);
      await holder.query('SELECT pg_advisory_unlock(73014132)');
      await holder.end();
      expect(await run).toBe(0);
      expect(await tables(DEV)).toEqual(['t_b', 't_c']);
      const order = await withDb(DEV, async (c) => (await c.query('SELECT t FROM order_log ORDER BY n')).rows.map((r) => r.t));
      expect(order).toEqual(['t_b', 't_c']);
    });
  });

  describe('historic ignore list is bounded', () => {
    it('ignores a frozen name but fails any other prod-but-not-dev file, even with --apply-dev', async () => {
      const listed = mf([...HISTORIC_DEV_UNTRACKED][0]!, create('t_old'));
      await seed([A, listed], [A]);
      expect(await gate([A, listed])).toBe(0);
      const fresh = mf('875_new.sql', create('t_new'));
      await withDb(PROD, (c) => track(c, fresh));
      expect(await gate([A, listed, fresh], { applyDev: true })).toBe(1);
      expect(out.join('\n')).toMatch(/DEV_MISSING_APPLIED_ON_PROD/);
      expect(await tables(DEV)).toEqual([]);
    });
  });
});
