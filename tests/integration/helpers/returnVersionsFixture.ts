/**
 * Fixture for the tax-return-versions suites (wave 5 L1a): a company with an admin and a
 * second member of a chosen role, a signed token per member, and a caller that goes through
 * the REAL route handlers (withAuth, CSRF, write access), because a 4xx commits the request's
 * writes there and that is the property under test.
 */
import { SignJWT } from 'jose';
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { request, response } from '../mfa-impersonation-postgres.helpers';
import { dropFixture, seedFixture, type Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;
type Handler = (req: never, res: never) => Promise<unknown> | unknown;

export interface Member { userId: string; token: string }
export interface ReturnFixture { fx: Fixture; admin: Member; manager: Member; viewer: Member }

async function sign(userId: string, sessionId?: string): Promise<string> {
  return new SignJWT({ sub: userId, aal: 'aal2', ...(sessionId ? { session_id: sessionId } : {}) })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function member(companyId: string, userId: string, role: string): Promise<Member> {
  await sql`INSERT INTO users (id, email, role, is_active)
    VALUES (${userId}, ${`rv-${userId}@isaflow.test`}, 'admin', true)`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${companyId}::UUID, ${userId}, ${role})`;
  return { userId, token: await sign(userId) };
}

export async function seedReturnFixture(prefix: string, databaseUrl: string): Promise<ReturnFixture> {
  const fx = await seedFixture(prefix, databaseUrl);
  const admin = await member(fx.companyId, fx.userId, 'admin');
  const manager = await member(fx.companyId, randomUUID(), 'manager');
  const viewer = await member(fx.companyId, randomUUID(), 'viewer');
  return { fx, admin, manager, viewer };
}

/** A Login-as token: its session is recorded in impersonation_sessions, as the admin start route does. */
export async function loginAsToken(rf: ReturnFixture): Promise<string> {
  const sessionId = randomUUID();
  await sql`INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id)
    VALUES (${sessionId}, ${randomUUID()}, ${rf.admin.userId})`;
  return sign(rf.admin.userId, sessionId);
}

export async function callRoute(
  handler: Handler, companyId: string, token: string, method: 'GET' | 'POST',
  query: Record<string, string>, body?: Record<string, unknown>,
): Promise<{ status: number; body: Row }> {
  const req = request({ 'sb-access-token': token, active_company_id: companyId }, method) as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = body;
  req.query = query;
  const out = response();
  await handler(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as Row };
}

export async function count(table: 'tax_return_versions' | 'vat_period_locks' | 'vat_gate_overrides', companyId: string): Promise<number> {
  const rows = table === 'tax_return_versions'
    ? await sql`SELECT COUNT(*)::INT AS n FROM tax_return_versions WHERE company_id = ${companyId}::UUID`
    : table === 'vat_period_locks'
      ? await sql`SELECT COUNT(*)::INT AS n FROM vat_period_locks WHERE company_id = ${companyId}::UUID`
      : await sql`SELECT COUNT(*)::INT AS n FROM vat_gate_overrides WHERE company_id = ${companyId}::UUID`;
  return Number((rows as Row[])[0]!.n);
}

/**
 * Teardown only: DISABLE TRIGGER, `fn`, ENABLE ALWAYS in ONE transaction on one client, so no other session ever
 * sees the immutability trigger off (the table refuses every DELETE and recorded-figure UPDATE).
 */
async function withVersionsMutable(pool: Pool, fn: (c: PoolClient) => Promise<unknown>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tax_return_versions DISABLE TRIGGER trg_tax_return_versions_immutable');
    await fn(c);
    await c.query('ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Releases a lock the way only a direct write can once 971's trigger forbids it for a lock a live version names:
 * the trigger off, the UPDATE, the trigger back ON ALWAYS, in one transaction on one client.
 */
export async function releaseLockDirectly(pool: Pool, lockId: string, userId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE vat_period_locks DISABLE TRIGGER trg_vat_period_locks_in_return');
    await c.query(`UPDATE vat_period_locks SET unlocked_at = now(), unlocked_by = $2, unlock_reason = 'direct' WHERE id = $1`, [lockId, userId]);
    await c.query('ALTER TABLE vat_period_locks ENABLE ALWAYS TRIGGER trg_vat_period_locks_in_return');
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function dropReturnFixture(rf: ReturnFixture): Promise<void> {
  const c = rf.fx.companyId;
  await withVersionsMutable(rf.fx.pool, (cl) => cl.query('DELETE FROM tax_return_versions WHERE company_id = $1', [c]));
  await sql`DELETE FROM sars_submissions WHERE company_id = ${c}::UUID`; // after the versions that name them
  await sql`DELETE FROM vat_returns WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM vat_gate_overrides WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM vat_period_locks WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM company_users WHERE company_id = ${c}::UUID`;
  const ids = [rf.admin.userId, rf.manager.userId, rf.viewer.userId];
  await sql`DELETE FROM impersonation_sessions WHERE target_user_id = ANY(${ids}::TEXT[])`;
  await sql`DELETE FROM audit_log WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM users WHERE id = ANY(${ids}::TEXT[])`;
  await dropFixture(rf.fx);
}
