/**
 * Migration 1018, round 11 (the merge queue's codex gate) on the suites' own fixtures. G5: the services' login is the
 * fixture's own role, so provisioning it never changes the cluster-wide isaflow_app password a running app may use.
 * G6: the ledger fixture writes only when the database `sql` uses (SERVICE_DATABASE_URL first) is the validated
 * disposable one.
 */
import { Client } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropAppLogin, FIXTURE_LOGIN, provisionAppLogin } from './helpers/appLoginWorld';
import { assertFixtureTarget, seedFreeze } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
const appPassword = async () => ((await sql`SELECT rolpassword AS p FROM pg_authid WHERE rolname = 'isaflow_app'`) as Row[])[0]!.p;

describeIfDisposable('ledger column immutability, round 11: the fixtures (migration 1018)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('G5 provisioning the services login (even from scratch) leaves the isaflow_app password alone', async () => {
    const url = process.env.DATABASE_URL!;
    const before = await appPassword();
    const admin = new URL(url); admin.pathname = '/postgres';
    const c = new Client({ connectionString: admin.toString() });
    await c.connect();
    try { await c.query('DROP TABLE IF EXISTS public.ci_isaflow_app_login'); } finally { await c.end(); } // force a provisioning
    const password = await provisionAppLogin(url);
    expect(await appPassword()).toEqual(before);
    const login = new URL(url); login.username = FIXTURE_LOGIN; login.password = password;
    const probe = new Client({ connectionString: login.toString() });
    await probe.connect();
    try {
      const r = (await probe.query(`SELECT session_user AS s, current_setting('is_superuser') AS su,
        (SELECT rolinherit FROM pg_roles WHERE rolname = session_user) AS inherit`)).rows[0];
      expect(r).toEqual({ s: FIXTURE_LOGIN, su: 'off', inherit: false });
      await probe.query('BEGIN');
      await probe.query('SET LOCAL ROLE app_user'); // the request transaction's role, as for isaflow_app
      await probe.query('ROLLBACK');
    } finally { await probe.end(); await dropAppLogin(url); }
  });

  it('L2 (round 12) no fixture login, and no fixture write, on a cluster that holds a database other than the disposable ones', async () => {
    const url = process.env.DATABASE_URL!;
    const foreign = `r12_foreign_${Date.now()}`;
    const admin = new URL(url); admin.pathname = '/postgres';
    const c = new Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`CREATE DATABASE ${foreign}`);
      await expect(provisionAppLogin(url)).rejects.toThrow(new RegExp(`refusing a fixture login on a cluster that also holds ${foreign}`));
      await expect(assertFixtureTarget()).rejects.toThrow(/refusing a fixture login on a cluster/);
      expect((await c.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [FIXTURE_LOGIN])).rows[0].n).toBe(0);
    } finally {
      await c.query(`DROP DATABASE IF EXISTS ${foreign}`);
      await c.end();
    }
    await expect(assertFixtureTarget()).resolves.toBeUndefined(); // over-strict check: the disposable cluster passes
  });

  it('G6 the fixture refuses to write when sql would use another database than the validated one', async () => {
    vi.stubEnv('SERVICE_DATABASE_URL', 'postgresql://postgres@db.example.com:5432/isaflow_dev');
    await expect(assertFixtureTarget()).rejects.toThrow(/refusing to write/);
    await expect(seedFreeze()).rejects.toThrow(/refusing to write/);
    const other = new URL(process.env.DATABASE_URL!);
    other.pathname = other.pathname === '/isaflow_test' ? '/isaflow_schema_fixture' : '/isaflow_test';
    vi.stubEnv('SERVICE_DATABASE_URL', other.toString()); // disposable, but not the validated one
    await expect(assertFixtureTarget()).rejects.toThrow(/refusing to write/);
    vi.stubEnv('SERVICE_DATABASE_URL', ''); // over-strict check: unset falls back to DATABASE_URL
    await expect(assertFixtureTarget()).resolves.toBeUndefined();
  });
});
