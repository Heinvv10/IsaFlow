/**
 * PR #1405 breaker round 6 (WP14b): an audit row names its target by the canonical id, whatever spelling the request
 * used, so the audit view (GET /api/admin/audit?entity_id=<id>, matched exactly) lists it. Real admin routes on the
 * disposable fixture.
 *
 *   - H1 (logAdminAction): a 'user' target is the stored users.id (users.id is TEXT and can hold capitals); any other
 *     UUID-shaped target is lower case. company-role and remove-from-company with a mixed-case stored user id,
 *     addressed in lower case, used to audit the URL's spelling.
 *   - H2: body ids are AdminUuid: a trial extension / bulk extension / job retry with an upper-cased body id audits
 *     (and details) the lower-case id.
 *   - H3: reset-2fa resolves the stored user first, then calls GoTrue and writes both audit rows with that id: an
 *     upper-cased super admin's id still records target_super_admin under the real id.
 * GoTrue's MFA calls are stubbed at the module boundary. Tokens are aal2. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const gotrue = vi.hoisted(() => ({ listedFor: [] as string[], unenrolledFor: [] as string[] }));
vi.mock('@/lib/auth/gotrue-mfa', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/gotrue-mfa')>()),
  adminListUserFactors: async (userId: string) => {
    gotrue.listedFor.push(userId);
    return [{ id: 'wp14b-factor', factor_type: 'totp', status: 'verified' }];
  },
  adminUnenrollFactor: async (userId: string) => { gotrue.unenrolledFor.push(userId); },
}));

import auditRoute from '../../pages/api/admin/audit';
import trialsRoute from '../../pages/api/admin/trials';
import jobQueueRoute from '../../pages/api/admin/job-queue';
import companyRoleRoute from '../../pages/api/admin/users/[id]/company-role';
import removeFromCompanyRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import reset2faRoute from '../../pages/api/admin/users/[id]/reset-2fa';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const company2 = crypto.randomUUID();
const superAdmin = crypto.randomUUID();
const job = crypto.randomUUID();
const TAG = `wp14b-r7-${Date.now()}`;
const mixedUser = `MixedCase-${TAG}`; // a stored id with capitals: users.id is TEXT and adminUserId admits it

type Body = { data?: { items?: Array<{ action?: string }> }; error?: { message?: string } };
async function call(route: unknown, method: string, query: Record<string, string>, body: unknown = {}) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.query = query;
  req.body = body;
  req.url = '/api/admin/x';
  const result = response();
  await (route as (q: never, s: never) => Promise<unknown>)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
const rows = async (target: string, action: string) => (await pool.query(
  'SELECT target_id, details FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND lower(target_id) = lower($3)',
  [admin, action, target])).rows as Array<{ target_id: string; details: Record<string, unknown> | null }>;
/** The actions the audit view lists for this exact id. */
async function view(entityId: string): Promise<string[]> {
  const r = await call(auditRoute, 'GET', { source: 'admin', entity_id: entityId, limit: '100' });
  expect(r.status).toBe(200);
  return (r.body.data?.items ?? []).map((i) => i.action ?? '');
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'super_admin', true),
    ($5, $6, 'viewer', true)`, [admin, `${admin}@test.local`, superAdmin, `${superAdmin}@test.local`, mixedUser, `${TAG}-mixed@test.local`]);
  await pool.query(`INSERT INTO companies (id, name, trial_ends_at) VALUES ($1, $2, now() + interval '5 days'), ($3, $4, now() + interval '5 days')`,
    [company, `${TAG} co`, company2, `${TAG} co2`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, mixedUser]);
  await pool.query(`INSERT INTO background_jobs (id, job_type, status) VALUES ($1, $2, 'failed')`, [job, TAG]);
}, 60000);
beforeEach(async () => {
  gotrue.listedFor = []; gotrue.unenrolledFor = [];
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM background_jobs WHERE job_type = $1', [TAG]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, company2]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, company2]]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, superAdmin, mixedUser]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('H1: a user target is the stored users.id', () => {
  it('company-role then remove-from-company, addressed in lower case: audited under the stored mixed-case id', async () => {
    const lower = mixedUser.toLowerCase();
    expect((await call(companyRoleRoute, 'PATCH', { id: lower }, { company_id: company, role: 'accountant' })).status).toBe(200);
    expect((await call(removeFromCompanyRoute, 'DELETE', { id: lower }, { company_id: company })).status).toBe(200);
    expect((await rows(mixedUser, 'user.change_company_role')).map((r) => r.target_id)).toEqual([mixedUser]);
    expect((await rows(mixedUser, 'user.remove_from_company')).map((r) => r.target_id)).toEqual([mixedUser]);
    expect(await view(mixedUser)).toEqual(expect.arrayContaining(['user.change_company_role', 'user.remove_from_company']));
  });
});

describe('H2: body ids are canonical', () => {
  it('trial extend with an upper-cased company_id: audited under the real id, listed in its audit view', async () => {
    expect((await call(trialsRoute, 'POST', {}, { company_id: company.toUpperCase(), days: 3 })).status).toBe(200);
    expect((await rows(company, 'trial.extend')).map((r) => r.target_id)).toEqual([company]);
    expect(await view(company)).toContain('trial.extend');
  });

  it('bulk trial extend with upper-cased company_ids: the details list the real ids', async () => {
    const r = await call(trialsRoute, 'POST', {}, { company_ids: [company.toUpperCase(), company2.toUpperCase()], days: 2 });
    expect(r.status).toBe(200);
    const audit = (await pool.query(`SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'trial.bulk_extend'`,
      [admin])).rows.map((x) => (x.details as { company_ids: string[] }).company_ids);
    expect(audit).toEqual([[company, company2]]);
  });

  it('job retry with an upper-cased jobId: audited under the real id', async () => {
    expect((await call(jobQueueRoute, 'POST', {}, { action: 'retry', jobId: job.toUpperCase() })).status).toBe(200);
    const targets = (await pool.query(`SELECT target_id FROM admin_audit_log WHERE admin_user_id = $1 AND lower(target_id) = $2`,
      [admin, job])).rows.map((x) => x.target_id);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t === job)).toBe(true);
  });
});

describe('H3: reset-2fa resolves the stored user first', () => {
  it('an upper-cased super admin id: GoTrue and both audit rows use the real id, target_super_admin recorded', async () => {
    const r = await call(reset2faRoute, 'POST', { id: superAdmin.toUpperCase() });
    expect(r.status).toBe(200);
    expect(gotrue.listedFor).toEqual([superAdmin]);
    expect(gotrue.unenrolledFor).toEqual([superAdmin]);
    const started = await rows(superAdmin, 'user.reset_2fa_started');
    expect(started.map((x) => [x.target_id, x.details?.target_super_admin])).toEqual([[superAdmin, true]]);
    expect((await rows(superAdmin, 'user.reset_2fa')).map((x) => x.target_id)).toEqual([superAdmin]);
    expect(await view(superAdmin)).toEqual(expect.arrayContaining(['user.reset_2fa_started', 'user.reset_2fa']));
  });

  it('a user that does not exist: 404 before GoTrue, no audit row', async () => {
    const ghost = crypto.randomUUID();
    expect((await call(reset2faRoute, 'POST', { id: ghost })).status).toBe(404);
    expect(gotrue.listedFor).toEqual([]);
    expect(await rows(ghost, 'user.reset_2fa_started')).toEqual([]);
  });
});
