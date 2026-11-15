/**
 * Admin audit 2026-11-14 F-11 and F-13 (WP14d), through the real admin routes (withAdmin, withPlatformAdmin on
 * platform_admin) on the disposable fixture.
 *
 *   F-13 POST /api/admin/companies/[id]/impersonate minted (and audited as a success) a token for a company that
 *        does not exist, or was deleted: now 404 before anything is minted, and no `company.impersonate` row.
 *        Review #1407: it refuses everything impersonate-exchange would refuse, so it never mints a dead token: a
 *        suspended / suspended_at / inactive company is a 404, and a company the admin is not a member of is the
 *        exchange's own 403.
 *   F-11 POST /api/admin/users/[id]/reset-password answered 500 for a missing user or a super-admin target (the
 *        service threw after the audit row): now 404 / 403 with the reason, before any token is written, any email
 *        is sent or the reset is audited. Review #1407: each refusal is logged (user id and reason, never an email
 *        address), and the TEXT user id is matched case-insensitively (an upper-cased id is the same user, and the
 *        audit row and the reset use that user's real id).
 * sendEmail is mocked: no email leaves the test. Tokens are aal2.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { log } from '@/lib/logger';

const sendEmail = vi.hoisted(() => vi.fn(async (_opts: { to: string; html: string }) => ({ success: true })));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));

import impersonateCompany from '../../pages/api/admin/companies/[id]/impersonate';
import resetPassword from '../../pages/api/admin/users/[id]/reset-password';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const admin = crypto.randomUUID();
const otherSuper = crypto.randomUUID();
const company = crypto.randomUUID();
const deletedCompany = crypto.randomUUID();
const suspendedCompany = crypto.randomUUID();
const suspendedAtCompany = crypto.randomUUID();
const inactiveCompany = crypto.randomUUID();
const notMemberCompany = crypto.randomUUID();
const member = crypto.randomUUID();
const allCompanies = [company, deletedCompany, suspendedCompany, suspendedAtCompany, inactiveCompany, notMemberCompany];
const TAG = `wp14d-${Date.now()}`;

type Body = { success?: boolean; data?: { token?: string }; error?: { code?: string; message?: string } };
async function call(route: unknown, id: string, url: string) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'POST', id) as unknown as { body: unknown; url: string };
  req.body = {};
  req.url = url;
  const result = response();
  await (route as (q: never, s: never) => Promise<unknown>)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
const audits = async (action: string, target: string) => (await pool.query(
  'SELECT count(*)::int AS n FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND target_id = $3',
  [admin, action, target])).rows[0].n as number;

beforeAll(async () => {
  vi.stubEnv('IMPERSONATION_JWT_SECRET', 'wp14d-synthetic-impersonation-signing-key-over-32');
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-r032-stash-encryption-key-over-32-characters');
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'super_admin', true),
    ($5, $6, 'viewer', true)`, [admin, `${admin}@test.local`, otherSuper, `${otherSuper}@test.local`, member, `${member}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)`,
    [company, `${TAG} live`, notMemberCompany, `${TAG} live, admin not a member`]);
  await pool.query(`INSERT INTO companies (id, name, status) VALUES ($1, $2, 'deleted'), ($3, $4, 'suspended')`,
    [deletedCompany, `${TAG} deleted`, suspendedCompany, `${TAG} suspended`]);
  await pool.query(`INSERT INTO companies (id, name, suspended_at) VALUES ($1, $2, now())`, [suspendedAtCompany, `${TAG} suspended_at`]);
  await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, false)`, [inactiveCompany, `${TAG} inactive`]);
  // The admin is a member of every company but notMemberCompany: only the standing refuses the dead ones.
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) SELECT unnest($1::uuid[]), $2, 'admin'`,
    [allCompanies.filter((c) => c !== notMemberCompany), admin]);
}, 60000);
beforeEach(async () => {
  sendEmail.mockClear();
  // The route allows 5 impersonations a minute per admin; this file makes more.
  await pool.query('DELETE FROM rate_limit_counters WHERE key LIKE $1', [`impersonate:${admin}%`]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id = $1::uuid', [member]);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [admin]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [allCompanies]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, otherSuper, member]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79' OR key LIKE $1", [`impersonate:${admin}%`]);
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
});

describe('F-13: company impersonation needs a company', () => {
  it.each([
    ['a company that does not exist', crypto.randomUUID()],
    ['a deleted company', deletedCompany],
    ['a suspended company', suspendedCompany],
    ['a company with suspended_at set', suspendedAtCompany],
    ['an inactive company', inactiveCompany],
  ])('%s: 404, no token minted, nothing audited', async (_label, id) => {
    const r = await call(impersonateCompany, id, `/api/admin/companies/${id}/impersonate`);
    expect(r.status).toBe(404);
    expect(r.body.data?.token).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
    expect(await audits('company.impersonate', id)).toBe(0);
  });

  it('a live company the admin is not a member of: the exchange\'s 403, no token, nothing audited', async () => {
    const r = await call(impersonateCompany, notMemberCompany, `/api/admin/companies/${notMemberCompany}/impersonate`);
    expect(r.status).toBe(403);
    expect(r.body.error?.message).toMatch(/not a member of this company.*user-impersonation/i);
    expect(JSON.stringify(r.body)).not.toMatch(/token/i);
    expect(await audits('company.impersonate', notMemberCompany)).toBe(0);
  });

  it('a live company still gets its token, audited', async () => {
    const r = await call(impersonateCompany, company, `/api/admin/companies/${company}/impersonate`);
    expect(r.status).toBe(200);
    expect(typeof r.body.data?.token).toBe('string');
    expect(await audits('company.impersonate', company)).toBe(1);
  });
});

describe('F-11: reset-password refuses with the reason, before anything is written or sent', () => {
  const tokens = async (userId: string) => (await pool.query(
    'SELECT count(*)::int AS n FROM auth_password_reset_tokens WHERE user_id::text = $1', [userId])).rows[0].n as number;
  /** The refusal's log.warn calls: [message, data] with the user id and reason. */
  const refusalWarns = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.filter((c) => /reset.*refused/i.test(String(c[0])));

  it('a user who does not exist: 404 saying so; no token, no email, no audit row', async () => {
    const ghost = crypto.randomUUID();
    const warn = vi.spyOn(log, 'warn');
    const r = await call(resetPassword, ghost, `/api/admin/users/${ghost}/reset-password`);
    expect(refusalWarns(warn).map((c) => c[1])).toEqual([{ userId: ghost, reason: 'not_found' }]);
    warn.mockRestore();
    expect(r.status).toBe(404);
    expect(r.body.error?.message).toMatch(/not found/i);
    expect(await tokens(ghost)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await audits('user.reset_password', ghost)).toBe(0);
  });

  it('a super admin: 403 saying why; no token, no email, no audit row', async () => {
    const warn = vi.spyOn(log, 'warn');
    const r = await call(resetPassword, otherSuper, `/api/admin/users/${otherSuper}/reset-password`);
    const warned = refusalWarns(warn);
    warn.mockRestore();
    expect(warned.map((c) => c[1])).toEqual([{ userId: otherSuper, reason: 'super_admin' }]);
    expect(JSON.stringify(warned)).not.toContain('@test.local');
    expect(r.status).toBe(403);
    expect(r.body.error?.message).toMatch(/super admin/i);
    expect(await tokens(otherSuper)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await audits('user.reset_password', otherSuper)).toBe(0);
  });

  it('an upper-cased super admin id is the same super admin: 403, no token, no email', async () => {
    const upper = otherSuper.toUpperCase();
    const r = await call(resetPassword, upper, `/api/admin/users/${upper}/reset-password`);
    expect(r.status).toBe(403);
    expect(await tokens(otherSuper)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('an upper-cased user id resets that user: one token, the email to their address', async () => {
    const upper = member.toUpperCase();
    const r = await call(resetPassword, upper, `/api/admin/users/${upper}/reset-password`);
    expect(r.status).toBe(200);
    expect(await tokens(member)).toBe(1);
    expect(sendEmail.mock.calls.map((c) => c[0].to)).toEqual([`${member}@test.local`]);
    // The audit row names the user by their real id, so a search on it finds this reset.
    expect(await audits('user.reset_password', member)).toBe(1);
    expect(await audits('user.reset_password', upper)).toBe(0);
  });
});
