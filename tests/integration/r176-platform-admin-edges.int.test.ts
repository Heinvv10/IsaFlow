/**
 * R-176 — withPlatformAdmin's forced ROLLBACK (a critical audit write failed), and the pool
 * behind scripts/_pg.ts.
 *
 *   - the forced ROLLBACK fails: 500 AUDIT_WRITE_FAILED still goes out and the connection is
 *     destroyed, so the next admin request cannot commit the unaudited write;
 *   - the forced ROLLBACK fails and the one in the catch then succeeds: the connection is still
 *     destroyed. A cancel request is already on its way to that backend; pooling it would let
 *     that cancel hit the next request's statement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { call, response, type TestResponse } from './r159-auth-wrapper.helpers';
import { arm, armAllCheckouts, backendState, seen, survivesClientError, type Seen, type Statement } from './r176-evict.helpers';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { closeSql, withTransactionPg } from '../../scripts/_pg';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO = randomUUID();
const ADMIN = randomUUID();
let adminJwt = '';
const adminReq = () => request({ 'sb-access-token': adminJwt }, 'POST');
const customers = async (name: string) =>
  Number((await pool.query('SELECT count(*) AS n FROM customers WHERE company_id = $1 AND name = $2', [CO, name])).rows[0].n);

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [CO, 'R176 platform admin edges']);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)",
    [ADMIN, `r176-admin-${ADMIN}@isaflow.test`]);
  adminJwt = await new SignJWT({ sub: ADMIN, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM customers WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query('DELETE FROM users WHERE id = $1', [ADMIN]);
  } finally {
    await closeSql();
    await pool.end();
  }
});

/** A handler that writes a row, then finds its critical audit row could not be written. */
const audited = (name: string, fail: Statement[], s: Seen, times?: number) => withPlatformAdmin(async (_req: unknown, res: TestResponse) => {
  s.pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
  await sql`INSERT INTO customers (id, company_id, name) VALUES (${randomUUID()}::uuid, ${CO}::uuid, ${name})`;
  arm(als.getStore()!.client, fail, s, { times });
  als.getStore()!.criticalAuditFailed = true; // what auditService sets when the audit row cannot be written
  return res.status(200);
}) as never;

/** A healthy admin request on the same pool; its own write is rolled back too, only its backend matters. */
async function nextAdminWrite(name: string): Promise<{ pid: number; status: number }> {
  const s = seen();
  const r = await call(audited(name, [], s) as never, adminReq());
  return { pid: s.pid, status: r.status };
}

describe('withPlatformAdmin: a critical audit write failed', () => {
  it('the forced ROLLBACK fails: 500 AUDIT_WRITE_FAILED, connection destroyed, the unaudited write never lands', async () => {
    const s = seen(), name = `r176-${randomUUID()}`;
    const r = await call(audited(name, ['ROLLBACK'], s), adminReq());
    s.disarm();
    const state = await backendState(pool, s.pid, 'gone');
    const next = await nextAdminWrite(`${name}-next`);
    expect(s.refused.ROLLBACK).toBe(1);
    expect(r.threw).toBeNull();
    expect((r.body?.error as { code?: string } | undefined)?.code).toBe('AUDIT_WRITE_FAILED');
    expect(await customers(name)).toBe(0);
    expect(next.pid).not.toBe(s.pid);
    expect(state).toBeNull();
  });

  it('the forced ROLLBACK fails, then the one in the catch succeeds: still destroyed', async () => {
    const s = seen(), name = `r176-${randomUUID()}`;
    const { res } = response();
    let threw = 0;
    // The AUDIT_WRITE_FAILED answer goes out through the response's own end (withPlatformAdmin defers res.end
    // until the transaction is final), so that first write is where the socket fails.
    const realEnd = res.end.bind(res);
    res.end = (...a: unknown[]) => { if (threw === 0) { threw += 1; throw new Error('R-176 socket write failed'); } return realEnd(...a); };
    let rethrown: unknown = null;
    try { await (audited(name, ['ROLLBACK'], s, 1) as (req: unknown, res: unknown) => Promise<void>)(adminReq(), res); } catch (err) { rethrown = err; }
    s.disarm();
    const state = await backendState(pool, s.pid, 'gone');
    const next = await nextAdminWrite(`${name}-next`);
    expect(s.refused.ROLLBACK).toBe(1); // the forced one; the catch's ROLLBACK reached the server
    expect(threw).toBe(1);
    expect(rethrown).toBeNull(); // R-159: the catch answers the throw (a 500), it does not rethrow it
    expect(res.statusCode).toBe(500);
    expect(await customers(name)).toBe(0);
    expect(next.pid).not.toBe(s.pid); // not pooled: a ROLLBACK did fail on it, and a cancel is in flight
    expect(state).toBeNull();
  });

  it('a healthy forced ROLLBACK: 500 AUDIT_WRITE_FAILED and the connection is reused', async () => {
    const s = seen(), name = `r176-${randomUUID()}`;
    const r = await call(audited(name, [], s), adminReq());
    const state = await backendState(pool, s.pid, 'idle');
    const next = await nextAdminWrite(`${name}-next`);
    expect((r.body?.error as { code?: string } | undefined)?.code).toBe('AUDIT_WRITE_FAILED');
    expect(await customers(name)).toBe(0);
    expect(state).toBe('idle');
    expect(next.pid).toBe(s.pid);
  });
});

describe('scripts/_pg.ts', () => {
  it('its memoised pool survives a destroyed client\'s error', async () => {
    const s = seen();
    armAllCheckouts(['ROLLBACK'], s);
    const failed = await withTransactionPg(async (tx) => {
      await tx`SELECT 1`;
      throw new Error('R-176 forced failure');
    }, `${process.env.DATABASE_URL}?sslmode=disable`).then(() => false, () => true);
    s.disarm();
    expect(failed).toBe(true);
    expect(s.refused.ROLLBACK).toBe(1);
    expect(s.pools.map(survivesClientError)).toEqual([true]);
  });
});
