/**
 * withPlatformAdmin rolls a failed admin action back (NUMRACE register (c); Hein, 2026-10-08).
 *
 * It COMMITted whatever the handler had written when withErrorHandler (inside withAdmin) answered 500, and sent the
 * route's Set-Cookie/Location with it: the impersonate route could leave the admin holding the target's session and a
 * committed audit row behind a 500. Now a 5xx rolls the whole action back and drops those headers, as withAuth does,
 * and the failed attempt is still audited: one admin_audit_log row, written on its own connection after the rollback,
 * best-effort — it never resurrects the action, and a failing audit write never changes the answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const ADMIN = randomUUID();
const TAG = `NRFB-${Date.now()}`;
let token = '';

type Wire = { status: number; body: unknown; headers: Record<string, unknown> };
function response() {
  const headers: Record<string, unknown> = {};
  const wire: Wire[] = [];
  const res = {
    statusCode: 200, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(body: unknown) { return this.end(JSON.stringify(body)); },
    end(body?: unknown) {
      wire.push({ status: this.statusCode, body: body === undefined ? null : JSON.parse(String(body)), headers: { ...headers } });
      return this;
    },
  };
  return { res, wire };
}

/** A route that writes (a marker audit row stands in for the admin action), sets a cookie and a Location, then answers. */
const route = (marker: string, answer: (res: NextApiResponse) => void) => withErrorHandler((async (
  _req: unknown, res: NextApiResponse) => {
  await sql`INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id)
    VALUES (${ADMIN}, 'nrfb_action', 'test', ${marker})`;
  res.setHeader('Set-Cookie', ['sb-access-token=target-session; Path=/; HttpOnly']);
  res.setHeader('Location', '/accounting');
  answer(res);
}) as never);

async function call(handler: unknown, method = 'POST') {
  const o = response();
  await withPlatformAdmin(handler as never)({ headers: { cookie: `sb-access-token=${token}` },
    url: `/api/admin/nrfb?secret=x`, method, socket: { remoteAddress: '127.0.0.1' } } as never, o.res as never);
  return o.wire;
}
const rows = async (action: string, marker?: string) => (await pool.query(
  `SELECT action, target_type, target_id, details, ip_address FROM admin_audit_log
   WHERE admin_user_id = $1 AND action = $2 AND ($3::text IS NULL OR target_id = $3) ORDER BY created_at`,
  [ADMIN, action, marker ?? null])).rows as
  { action: string; target_id: string | null; details: Record<string, unknown>; ip_address: string | null }[];

describe('withPlatformAdmin: a 5xx rolls the admin action back, the attempt is still audited', () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`,
      [ADMIN, `${TAG}@test.local`]);
    token = await new SignJWT({ sub: ADMIN, aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    try {
      await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS nrfb_block_failure_audit`);
      await pool.query(`DELETE FROM admin_audit_log WHERE admin_user_id = $1`, [ADMIN]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN]);
    } finally { await pool.end(); }
  });

  it('a handler that answers 500 after writing: nothing commits, no Set-Cookie/Location, one failure row', async () => {
    const m = `${TAG}-500`;
    const wire = await call(route(m, (res) => { res.status(500).json({ success: false, error: { code: 'X' } }); }));
    expect(wire).toHaveLength(1);
    expect(wire[0]!.status).toBe(500);
    expect(wire[0]!.headers['set-cookie']).toBeUndefined();
    expect(wire[0]!.headers.location).toBeUndefined();
    expect(await rows('nrfb_action', m)).toEqual([]);
    const failed = await rows('admin_request_failed');
    expect(failed.filter((r) => (r.details as { status?: number }).status === 500 && r.details.reason === 'rolled_back'))
      .toHaveLength(1);
    expect(failed.at(-1)!.details).toMatchObject({ method: 'POST', route: '/api/admin/nrfb', status: 500 });
    expect(failed.at(-1)!.ip_address).toBe('127.0.0.1');
    expect(failed.at(-1)!.target_id).toBeNull(); // no id in this path
  });

  it('a handler that throws (withErrorHandler answers 500): rolled back and audited the same way', async () => {
    const m = `${TAG}-throw`;
    const before = (await rows('admin_request_failed')).length;
    const wire = await call(route(m, () => { throw new Error('boom after the cookies'); }));
    expect(wire[0]!.status).toBe(500);
    expect(wire[0]!.headers['set-cookie']).toBeUndefined();
    expect(await rows('nrfb_action', m)).toEqual([]);
    expect((await rows('admin_request_failed')).length).toBe(before + 1);
  });

  it('a 200 still commits, keeps its cookie and writes no failure row', async () => {
    const m = `${TAG}-200`;
    const before = (await rows('admin_request_failed')).length;
    const wire = await call(route(m, (res) => { res.status(200).json({ success: true }); }));
    expect(wire[0]!.status).toBe(200);
    expect(wire[0]!.headers['set-cookie']).toBeDefined();
    expect(await rows('nrfb_action', m)).toHaveLength(1);
    expect((await rows('admin_request_failed')).length).toBe(before);
  });

  it('a 4xx keeps committing, as before (a validation answer returns before its writes)', async () => {
    const m = `${TAG}-400`;
    const wire = await call(route(m, (res) => { res.status(400).json({ success: false }); }));
    expect(wire[0]!.status).toBe(400);
    expect(await rows('nrfb_action', m)).toHaveLength(1);
  });

  it('a GET that 5xxs changed nothing to audit: rolled back, no failure row', async () => {
    const m = `${TAG}-get`;
    const before = (await rows('admin_request_failed')).length;
    const wire = await call(route(m, (res) => { res.status(500).json({ success: false }); }), 'GET');
    expect(wire[0]!.status).toBe(500);
    expect(await rows('nrfb_action', m)).toEqual([]);
    expect((await rows('admin_request_failed')).length).toBe(before);
  });

  it('a failing failure-audit write changes nothing: the same 500, the action still rolled back', async () => {
    await pool.query(`ALTER TABLE admin_audit_log ADD CONSTRAINT nrfb_block_failure_audit
      CHECK (action <> 'admin_request_failed' OR admin_user_id <> '${ADMIN}') NOT VALID`);
    try {
      const m = `${TAG}-auditfail`;
      const wire = await call(route(m, (res) => { res.status(500).json({ success: false, error: { code: 'X' } }); }));
      expect(wire).toEqual([expect.objectContaining({ status: 500, body: { success: false, error: { code: 'X' } } })]);
      expect(await rows('nrfb_action', m)).toEqual([]);
    } finally {
      await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS nrfb_block_failure_audit`);
    }
  });
});
