/**
 * Calls a real admin route (withAdmin: withPlatformAdmin + error handler + the
 * X-Admin-Request and CSRF checks) as a super_admin, on the disposable fixture.
 * The admin is a users row this helper creates and `dropAdmin` removes.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

export interface Wire { status: number; body: { success?: boolean; data?: Record<string, unknown>; message?: string; error?: unknown } }

const CSRF = 'wp11-csrf-0123456789abcdef0123456789abcdef';

export async function createAdmin(pool: Pool, tag: string): Promise<{ id: string; token: string }> {
  assertDisposable();
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`,
    [id, `${tag}-${id.slice(0, 8)}@test.local`]);
  const token = await new SignJWT({ sub: id, aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return { id, token };
}

export async function dropAdmin(pool: Pool, id: string): Promise<void> {
  await pool.query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [id]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
}

export async function callAdmin(
  handler: unknown, token: string,
  opts: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<Wire> {
  const wire: Wire[] = [];
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 200, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(body: unknown) { return this.end(JSON.stringify(body)); },
    end(body?: unknown) {
      wire.push({ status: this.statusCode, body: body === undefined ? {} : JSON.parse(String(body)) });
      return this;
    },
  };
  const req = {
    method: opts.method ?? 'POST',
    url: '/api/admin/wp11',
    query: opts.query ?? {},
    body: opts.body ?? {},
    headers: {
      cookie: `sb-access-token=${token}; isaflow_csrf=${CSRF}`,
      'x-admin-request': 'true', 'x-csrf-token': CSRF, 'content-type': 'application/json',
    },
    cookies: { 'sb-access-token': token, isaflow_csrf: CSRF },
    socket: { remoteAddress: '127.0.0.1' },
  };
  await (handler as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return wire[wire.length - 1] ?? { status: 0, body: {} };
}
