/**
 * NUMRACE: migration 864's `public.take_number_lock(scope, seed)` — idempotent, no proconfig, and the 5 s wait
 * bound of migration 858: tighten-only, the caller's lock_timeout restored after the call.
 *
 * Every case runs the migration file's own text inside a transaction that is rolled back, so the file is
 * exercised as the runner applies it (one transaction per file) and nothing survives on the fixture. The key is
 * held by a second connection.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { Pool, type PoolClient } from 'pg';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
const MIGRATION = path.join(__dirname, '../../scripts/migrations/sql/864_take_number_lock.sql');
const SCOPE = `numrace-fn-${crypto.randomUUID()}`;

async function inRolledBack<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(readFileSync(MIGRATION, 'utf8'));
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

async function heldBy<T>(fn: () => Promise<T>): Promise<T> {
  const h = await pool.connect();
  try {
    await h.query('BEGIN');
    await h.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 864999))', [SCOPE]);
    return await fn();
  } finally {
    await h.query('ROLLBACK').catch(() => undefined);
    h.release();
  }
}

async function timedLock(c: PoolClient): Promise<{ code: string; ms: number }> {
  await c.query('SAVEPOINT s');
  const t0 = Date.now();
  try {
    await c.query('SELECT public.take_number_lock($1, 864999)', [SCOPE]);
    await c.query('RELEASE SAVEPOINT s');
    return { code: 'ok', ms: Date.now() - t0 };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    return { code: String((e as { code?: string }).code), ms: Date.now() - t0 };
  }
}

const setting = async (c: PoolClient) => String((await c.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v);

describeIfDb('NUMRACE: take_number_lock (migration 864)', () => {
  afterAll(async () => { await pool.end(); });

  it('applies twice; the definition is unchanged; no proconfig; SECURITY INVOKER; app_user may execute', async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    await inRolledBack(async (c) => {
      const def = async () => (await c.query(`SELECT pg_get_functiondef(p.oid) AS d, p.proconfig, p.prosecdef,
        has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p WHERE p.oid = 'public.take_number_lock(text, bigint)'::regprocedure`)).rows[0];
      const first = await def();
      await c.query(readFileSync(MIGRATION, 'utf8'));
      const second = await def();
      expect(second.d).toBe(first.d);
      expect(first.proconfig).toBeNull();
      expect(first.prosecdef).toBe(false);
      expect(first.app_exec).toBe(true);
      expect(first.d).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_scope, p_seed\)\)/);
    });
  }, 60000);

  it('unbounded caller (lock_timeout 0): waits ~5 s then 55P03; after a free call the 0 is back', async () => {
    await inRolledBack(async (c) => {
      await c.query("SET LOCAL lock_timeout = 0");
      const r = await heldBy(() => timedLock(c));
      expect(r.code).toBe('55P03');
      expect(r.ms).toBeGreaterThanOrEqual(4500);
      expect(r.ms).toBeLessThan(8000);
      expect(await setting(c)).toBe('0');
      expect((await timedLock(c)).code).toBe('ok');
      expect(await setting(c)).toBe('0');
    });
  }, 60000);

  it('a looser caller (30 s) is tightened to 5 s for the wait and gets 30 s back', async () => {
    await inRolledBack(async (c) => {
      await c.query("SET LOCAL lock_timeout = '30s'");
      const r = await heldBy(() => timedLock(c));
      expect(r.code).toBe('55P03');
      expect(r.ms).toBeLessThan(8000);
      expect((await timedLock(c)).code).toBe('ok');
      expect(await setting(c)).toBe('30s');
    });
  }, 60000);

  it('a tighter caller (1 s) keeps its bound and its value', async () => {
    await inRolledBack(async (c) => {
      await c.query("SET LOCAL lock_timeout = '1s'");
      const r = await heldBy(() => timedLock(c));
      expect(r.code).toBe('55P03');
      expect(r.ms).toBeLessThan(3000);
      expect((await timedLock(c)).code).toBe('ok');
      expect(await setting(c)).toBe('1s');
    });
  }, 60000);
});
