/**
 * R-032 re-check LOW (pool): recording the impersonation session must not need
 * a SECOND platform_admin pool connection while the request already holds one.
 *
 * "Login as" runs inside withPlatformAdmin, which holds a platform_admin pool
 * connection for the whole request. Taking another from the same pool to
 * record the session deadlocks the moment the pool is exhausted. Here every
 * connection but one is checked out first, so the request holds the last one
 * and a pool-based record waits for it until connectionTimeoutMillis. The
 * record uses its own one-off connection. (The pool size is not changed through
 * the environment: integration files share one process's env.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const fx = loginAsFixture(pool, 'R032 pool');

beforeAll(() => fx.setUp());
afterAll(async () => {
  try { await fx.tearDown(); } finally { await pool.end(); }
});

describe('R-032 — the session record does not wait on the request\'s own pool', () => {
  it('starts a Login-as session when the request holds the pool\'s last connection', async () => {
    const adminPool = getPlatformAdminPool();
    const held: PoolClient[] = [];
    let jar: Record<string, string>;
    const started = Date.now();
    try {
      for (let i = 1; i < adminPool.options.max!; i++) held.push(await adminPool.connect());
      jar = await fx.loginAsTarget();
    } finally {
      for (const c of held) c.release();
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    const recorded = await pool.query('SELECT count(*) AS n FROM impersonation_sessions WHERE actor_user_id=$1',
      [fx.platformAdmin]);
    expect(Number(recorded.rows[0].n)).toBe(1);
    expect(jar['sb-access-token']).toBeTruthy();
  }, 30_000);
});
