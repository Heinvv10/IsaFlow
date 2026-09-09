import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { Secret, TOTP } from 'otpauth';
import { adminCreateUser, adminDeleteUser, signIn, verifyToken, verifyTokenSignature } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor } from '@/lib/auth/gotrue-mfa';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { sql } from '@/lib/neon';
import { applyCookies, assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const suffix = crypto.randomUUID();
const adminEmail = `mfa-pg-admin-${suffix}@test.local`;
const targetEmail = `mfa-pg-target-${suffix}@test.local`;
const password = 'Disposable-Mfa-Postgres!2026';
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
let adminId: string | undefined;
let targetId: string | undefined;
const priorKeys = { anon: process.env.SUPABASE_ANON_KEY, service: process.env.SUPABASE_SERVICE_ROLE_KEY };

beforeAll(async () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Disposable JWT_SECRET required');
  const mint = (role: string) => new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  process.env.SUPABASE_ANON_KEY = await mint('anon');
  process.env.SUPABASE_SERVICE_ROLE_KEY = await mint('service_role');
  adminId = (await adminCreateUser({ email: adminEmail, password, email_confirm: true })).id;
  targetId = (await adminCreateUser({ email: targetEmail, password, email_confirm: true })).id;
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES
    ($1, $2, 'super_admin', true), ($3, $4, 'viewer', true)`, [adminId, adminEmail, targetId, targetEmail]);
  await pool.query('INSERT INTO companies (id, name) VALUES ($1,$2),($3,$4)',
    [companyId, `MFA fixture ${suffix}`, otherCompanyId, `MFA other ${suffix}`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES
    ($1,$2,'admin',true),($3,$4,'admin',true)`, [companyId, targetId, otherCompanyId, adminId]);
  const initial = await signIn(targetEmail, password);
  const factor = await enrollTotp(initial.access_token, 'disposable postgres workflow');
  const totp = new TOTP({ secret: Secret.fromBase32(factor.secret), digits: 6, period: 30 });
  await verifyFactor(factor.factor_id, await challengeFactor(factor.factor_id, initial.access_token),
    totp.generate(), initial.access_token);
}, 60_000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1 AND target_id = $2', [adminId, targetId]);
    await pool.query('DELETE FROM admin_impersonation_stash WHERE admin_user_id = $1 AND target_user_id = $2', [adminId, targetId]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[]) AND user_id = ANY($2::text[])',
      [[companyId, otherCompanyId], [adminId, targetId].filter(Boolean)]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[companyId, otherCompanyId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[adminId, targetId].filter(Boolean)]);
    await pool.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::text[])',
      [['admin:127.0.0.79', 'auth-refresh:127.0.0.79']]);
  } finally {
    try {
      if (adminId) await adminDeleteUser(adminId);
      if (targetId) await adminDeleteUser(targetId);
    } finally {
      await pool.end();
      if (priorKeys.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
      else process.env.SUPABASE_ANON_KEY = priorKeys.anon;
      if (priorKeys.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = priorKeys.service;
    }
  }
});

it('real provider and schema: MFA target start, scoped GET, refresh, scoped GET, owned admin return', async () => {
  const admin = await signIn(adminEmail, password);
  const pending = await signIn(targetEmail, password);
  await expect(verifyToken(pending.access_token)).rejects.toThrow('MFA challenge required');
  const jar: Record<string, string> = { 'sb-access-token': admin.access_token, 'sb-refresh-token': admin.refresh_token };
  const { default: start } = await import('../../pages/api/admin/users/[id]/impersonate');
  const { default: refresh } = await import('../../pages/api/auth/refresh');
  const { default: end } = await import('../../pages/api/auth/end-impersonation');
  const started = response();
  await start(request(jar, 'POST', targetId), started.res);
  expect(started.state.statusCode, JSON.stringify(started.state.body)).toBe(200);
  applyCookies(jar, started);
  expect(jar.active_company_id).toBe(companyId);
  expect(jar['sb-impersonation-proof']).toBeTruthy();
  const claims = await verifyToken(jar['sb-access-token']!, jar['sb-impersonation-proof']);
  expect(claims.sub).toBe(targetId);
  expect(claims.aal).toBe('aal1');
  const stashId = jar['sb-admin-stash'];
  const stash = await pool.query(`SELECT admin_user_id, target_user_id, admin_access_token
    FROM admin_impersonation_stash WHERE stash_id=$1 AND admin_user_id=$2 AND target_user_id=$3`, [stashId, adminId, targetId]);
  expect(stash.rows).toHaveLength(1);
  expect(stash.rows[0].admin_access_token).not.toBe(admin.access_token);
  let calls = 0;
  const protectedGet = withAuth(async (req: CompanyAuthedRequest, res) => {
    calls++;
    const context = await sql<{ role: string; company: string; claims: string }>`SELECT current_user AS role,
      current_setting('app.current_company_id') AS company, current_setting('request.jwt.claims') AS claims`;
    expect(context[0]!.role).toBe('app_user');
    expect(context[0]!.company).toBe(req.companyId);
    expect(JSON.parse(context[0]!.claims).sub).toBe(req.user.id);
    const rows = await sql<{ company_id: string }>`SELECT company_id FROM company_users
      WHERE company_id = ${req.companyId}::uuid AND user_id = ${req.user.id}`;
    expect(rows).toEqual([{ company_id: req.companyId }]);
    if (req.user.id === targetId) {
      const otherRows = await sql<{ company_id: string }>`SELECT company_id FROM company_users
        WHERE company_id = ${otherCompanyId}::uuid AND user_id = ${adminId}`;
      expect(otherRows).toEqual([]);
    }
    res.status(200).json({ companyId: req.companyId });
  });
  const withoutProof = response();
  await protectedGet(request({ 'sb-access-token': pending.access_token, active_company_id: companyId }, 'GET'), withoutProof.res);
  expect(withoutProof.state.statusCode).toBe(401);
  expect(calls).toBe(0);
  const first = response();
  await protectedGet(request(jar, 'GET'), first.res);
  expect(first.state.statusCode, JSON.stringify(first.state.body)).toBe(200);
  const forbidden = response();
  await protectedGet(request({ ...jar, active_company_id: otherCompanyId }, 'GET'), forbidden.res);
  expect(forbidden.state.statusCode).toBe(403);
  expect(calls).toBe(1);
  const proof = jar['sb-impersonation-proof'];
  const refreshed = response();
  await refresh(request(jar, 'POST'), refreshed.res);
  expect(refreshed.state.statusCode, JSON.stringify(refreshed.state.body)).toBe(200);
  applyCookies(jar, refreshed);
  expect(jar['sb-impersonation-proof']).toBe(proof);
  const rotated = await verifyTokenSignature(jar['sb-access-token']!);
  expect(rotated.session_id).toBe(claims.session_id);
  expect(rotated.aal).toBe('aal1');
  const second = response();
  await protectedGet(request(jar, 'GET'), second.res);
  expect(second.state.statusCode).toBe(200);
  const ended = response();
  await end(request(jar, 'POST'), ended.res);
  expect(ended.state.statusCode, JSON.stringify(ended.state.body)).toBe(200);
  applyCookies(jar, ended);
  expect(jar['sb-access-token']).toBe(admin.access_token);
  expect(jar['sb-impersonation-proof']).toBeUndefined();
  expect(jar.active_company_id).toBe(otherCompanyId);
  const restored = response();
  await protectedGet(request(jar, 'GET'), restored.res);
  expect(restored.state.statusCode).toBe(200);
  expect(calls).toBe(3);
  expect((await pool.query('SELECT stash_id FROM admin_impersonation_stash WHERE stash_id=$1 AND admin_user_id=$2',
    [stashId, adminId])).rows).toHaveLength(0);
  const audit = await pool.query(`SELECT action FROM admin_audit_log
    WHERE admin_user_id=$1 AND target_id=$2 AND action IN ('impersonation_start','impersonation_end') ORDER BY action`, [adminId, targetId]);
  expect(audit.rows.map((row: { action: string }) => row.action)).toEqual(['impersonation_end', 'impersonation_start']);
}, 60_000);
