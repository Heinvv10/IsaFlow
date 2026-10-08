/**
 * "Login as" that fails AFTER the target's session cookies are set (NUMRACE register (c); Hein, 2026-10-08).
 *
 * Before: withErrorHandler answered the throw 500, withPlatformAdmin COMMITted (impersonation_start row and admin
 * token stash kept) and replayed the route's Set-Cookie — the admin's browser got the target's session behind a 500.
 * Now: 500, no Set-Cookie, no impersonation_start row and no stash from the action, and one admin_request_failed row.
 * Needs a disposable GoTrue (GOTRUE_URL on localhost) and isaflow_schema_fixture (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { adminCreateUser, adminDeleteUser, signIn } from '@/lib/auth/gotrue';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const failCookieStep = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/auth/impersonation-cookies', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/impersonation-cookies')>();
  return {
    ...actual,
    setImpersonationCookies: (...args: Parameters<typeof actual.setImpersonationCookies>) => {
      if (failCookieStep.on) throw new Error('impersonation cookie step failed');
      return actual.setImpersonationCookies(...args);
    },
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const STAMP = Date.now();
const ADMIN_EMAIL = `nrfb-imp-admin-${STAMP}@test.local`;
const TARGET_EMAIL = `nrfb-imp-target-${STAMP}@test.local`;
const PW = 'NrfbImp!Secret123';

function mkReq(cookies: Record<string, string>, targetId: string) {
  const csrf = 'c'.repeat(48);
  const all = { ...cookies, isaflow_csrf: csrf };
  return {
    method: 'POST',
    headers: { cookie: Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; '), 'x-admin-request': 'true', 'x-csrf-token': csrf },
    cookies: all, query: { id: targetId }, body: undefined, url: `/api/admin/users/${targetId}/impersonate`,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function mkRes() {
  const headers: Record<string, unknown> = {};
  const wire: { status: number; body: unknown; setCookie: unknown }[] = [];
  const res = {
    statusCode: 200, headersSent: false,
    status(c: number) { this.statusCode = c; return this; },
    setHeader(k: string, v: unknown) {
      const key = k.toLowerCase();
      headers[key] = key === 'set-cookie' ? [...((headers[key] as string[]) ?? []), ...(Array.isArray(v) ? v : [v])] : v;
      return this;
    },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    json(v: unknown) { return this.end(JSON.stringify(v)); },
    end(body?: unknown) {
      wire.push({ status: this.statusCode, body: body === undefined ? null : JSON.parse(String(body)), setCookie: headers['set-cookie'] });
      return this;
    },
  };
  return { res: res as unknown as NextApiResponse, wire };
}

describe('impersonate start that fails after setting the cookies', () => {
  let adminId = '';
  let targetId = '';

  beforeAll(async () => {
    adminId = (await adminCreateUser({ email: ADMIN_EMAIL, password: PW, email_confirm: true })).id;
    targetId = (await adminCreateUser({ email: TARGET_EMAIL, password: PW, email_confirm: true })).id;
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'viewer', true)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`, [adminId, ADMIN_EMAIL, targetId, TARGET_EMAIL]);
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM admin_audit_log WHERE admin_user_id IN ($1,$2) OR target_id IN ($1,$2)`, [adminId, targetId]);
      await pool.query(`DELETE FROM admin_impersonation_stash WHERE admin_user_id IN ($1,$2) OR target_user_id IN ($1,$2)`,
        [adminId, targetId]);
      await pool.query(`DELETE FROM impersonation_sessions WHERE actor_user_id IN ($1,$2) OR target_user_id IN ($1,$2)`,
        [adminId, targetId]);
      await pool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [adminId, targetId]);
      for (const id of [adminId, targetId]) {
        await adminDeleteUser(id).catch((e: unknown) => { process.stderr.write(`gotrue cleanup ${id}: ${String(e)}\n`); });
      }
    } finally { await pool.end(); }
  });

  it('500, no Set-Cookie, no impersonation_start row or stash from the action, one failure audit row', async () => {
    const toks = await signIn(ADMIN_EMAIL, PW);
    const { default: impersonate } = await import('../../pages/api/admin/users/[id]/impersonate');
    const o = mkRes();
    failCookieStep.on = true;
    try {
      await impersonate(mkReq({ 'sb-access-token': toks.access_token, 'sb-refresh-token': toks.refresh_token }, targetId), o.res);
    } finally { failCookieStep.on = false; }
    process.stdout.write(`NRFB-IMP ${JSON.stringify(o.wire.map((w) => ({ status: w.status, setCookie: w.setCookie })))}\n`);

    expect(o.wire).toHaveLength(1);
    expect(o.wire[0]!.status).toBe(500);
    expect(o.wire[0]!.setCookie).toBeUndefined();
    const start = await pool.query(`SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'impersonation_start'
      AND target_id = $2`, [adminId, targetId]);
    expect(start.rowCount).toBe(0);
    const stash = await pool.query(`SELECT 1 FROM admin_impersonation_stash WHERE admin_user_id = $1`, [adminId]);
    expect(stash.rowCount).toBe(0);
    const failed = await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'admin_request_failed'`,
      [adminId]);
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0].details).toMatchObject({ method: 'POST', route: `/api/admin/users/${targetId}/impersonate`, status: 500 });
  }, 60000);

  it('the same start without the failure still works: 200, the target session, impersonation_start committed', async () => {
    const toks = await signIn(ADMIN_EMAIL, PW);
    const { default: impersonate } = await import('../../pages/api/admin/users/[id]/impersonate');
    const o = mkRes();
    await impersonate(mkReq({ 'sb-access-token': toks.access_token, 'sb-refresh-token': toks.refresh_token }, targetId), o.res);
    expect(o.wire[0]!.status).toBe(200);
    expect(String(o.wire[0]!.setCookie)).toMatch(/sb-access-token=/);
    const start = await pool.query(`SELECT 1 FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'impersonation_start'`,
      [adminId]);
    expect(start.rowCount).toBe(1);
  }, 60000);
});
