// tests/integration/impersonation-flow.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { adminCreateUser, adminDeleteUser, signIn } from '@/lib/auth/gotrue';
import { verifyToken } from '@/lib/auth/gotrue';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_ADMIN_DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL || !MIGRATION_ADMIN_DATABASE_URL) {
  throw new Error('JWT_SECRET + DATABASE_URL + MIGRATION_ADMIN_DATABASE_URL required');
}

// Use DATABASE_URL (postgres) so we can read/write all tables in seed + cleanup
const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const ADMIN_EMAIL = `imp-admin-${Date.now()}@test.local`;
const TARGET_EMAIL = `imp-target-${Date.now()}@test.local`;
const PW = 'ImpTest!Secret123';

function mkReq(opts: { method: string; cookies: Record<string, string>; query?: Record<string, string>; body?: unknown }) {
  const cookieHeader = Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    method: opts.method,
    headers: { cookie: cookieHeader, 'x-admin-request': 'true' },
    cookies: opts.cookies,
    query: opts.query ?? {},
    body: opts.body,
    url: '/test',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function mkRes() {
  let status = 200;
  let body: unknown;
  const setCookies: string[] = [];
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader(k: string, v: string | string[]) {
      if (k.toLowerCase() === 'set-cookie') setCookies.push(...(Array.isArray(v) ? v : [v]));
    },
    getHeader(k: string) { return k.toLowerCase() === 'set-cookie' ? setCookies : undefined; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; }, get cookies() { return setCookies; } };
}

function cookieValue(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

describe('impersonation flow (integration)', () => {
  let adminId: string;
  let targetId: string;

  beforeAll(async () => {
    const adminUser = await adminCreateUser({ email: ADMIN_EMAIL, password: PW, email_confirm: true });
    const targetUser = await adminCreateUser({ email: TARGET_EMAIL, password: PW, email_confirm: true });
    adminId = adminUser.id;
    targetId = targetUser.id;

    await seedPool.query(
      `INSERT INTO users (id, email, role, is_active) VALUES
         ($1, $2, 'super_admin', true),
         ($3, $4, 'viewer', true)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
      [adminId, ADMIN_EMAIL, targetId, TARGET_EMAIL]
    );
  });

  afterAll(async () => {
    await seedPool.query(
      `DELETE FROM admin_audit_log
        WHERE admin_user_id IN ($1,$2)
           OR (target_type = 'user' AND target_id IN ($1,$2))`,
      [adminId, targetId]
    );
    await seedPool.query(
      `DELETE FROM admin_impersonation_stash
        WHERE admin_user_id IN ($1,$2) OR target_user_id IN ($1,$2)`,
      [adminId, targetId]
    );
    await seedPool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [adminId, targetId]);
    try { await adminDeleteUser(adminId); } catch { /* best-effort */ }
    try { await adminDeleteUser(targetId); } catch { /* best-effort */ }
    await seedPool.end();
  });

  it('start -> target session + stash + audit, end -> admin restored', async () => {
    const adminToks = await signIn(ADMIN_EMAIL, PW);

    const { default: impersonateHandler } = await import('../../pages/api/admin/users/[id]/impersonate');
    const r1 = mkRes();
    await impersonateHandler(
      mkReq({
        method: 'POST',
        cookies: {
          'sb-access-token': adminToks.access_token,
          'sb-refresh-token': adminToks.refresh_token,
        },
        query: { id: targetId },
      }),
      r1.res
    );
    expect(r1.status).toBe(200);
    expect((r1.body as { data: { redirect: string } }).data.redirect).toBe('/accounting');

    const newAccess = cookieValue(r1.cookies, 'sb-access-token');
    expect(newAccess).toBeTruthy();
    const stashId = cookieValue(r1.cookies, 'sb-admin-stash');
    expect(stashId).toBeTruthy();
    expect(cookieValue(r1.cookies, 'is_impersonating')).toBe('1');

    const claims = await verifyToken(newAccess!);
    expect(claims.sub).toBe(targetId);

    const { rows: stashRows } = await seedPool.query(
      `SELECT admin_user_id, target_user_id FROM admin_impersonation_stash WHERE stash_id = $1::uuid`,
      [stashId]
    );
    expect(stashRows).toHaveLength(1);
    expect(stashRows[0].admin_user_id).toBe(adminId);
    expect(stashRows[0].target_user_id).toBe(targetId);

    const { rows: startRows } = await seedPool.query(
      `SELECT action FROM admin_audit_log
        WHERE admin_user_id = $1 AND target_type = 'user' AND target_id = $2
          AND action = 'impersonation_start'`,
      [adminId, targetId]
    );
    expect(startRows.length).toBeGreaterThan(0);

    const { default: endHandler } = await import('../../pages/api/auth/end-impersonation');
    const r2 = mkRes();
    await endHandler(
      mkReq({
        method: 'POST',
        cookies: { 'sb-admin-stash': stashId! },
      }),
      r2.res
    );
    expect(r2.status).toBe(200);
    expect((r2.body as { data: { redirect: string } }).data.redirect).toBe('/admin');

    const restoredAccess = cookieValue(r2.cookies, 'sb-access-token');
    expect(restoredAccess).toBeTruthy();
    const restoredClaims = await verifyToken(restoredAccess!);
    expect(restoredClaims.sub).toBe(adminId);

    expect(r2.cookies.some((c) => /sb-admin-stash=;.*Max-Age=0/.test(c))).toBe(true);
    expect(r2.cookies.some((c) => /is_impersonating=;.*Max-Age=0/.test(c))).toBe(true);

    const { rows: afterRows } = await seedPool.query(
      `SELECT 1 FROM admin_impersonation_stash WHERE stash_id = $1::uuid`,
      [stashId]
    );
    expect(afterRows).toHaveLength(0);

    const { rows: endRows } = await seedPool.query(
      `SELECT action FROM admin_audit_log
        WHERE admin_user_id = $1 AND target_type = 'user' AND target_id = $2
          AND action = 'impersonation_end'`,
      [adminId, targetId]
    );
    expect(endRows.length).toBeGreaterThan(0);
  });
});
