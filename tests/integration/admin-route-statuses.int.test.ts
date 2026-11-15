/**
 * Admin audit 2026-11-14 section 6 (WP14b), through the real admin stack (withAdmin, withPlatformAdmin on
 * platform_admin, withErrorHandler) on the disposable fixture.
 *
 *   - an unexpected error is a 500 that ROLLS BACK: a catch-all used to answer 400, which committed whatever the
 *     route had written before the failure (here an announcement row) and hid the fault;
 *   - a malformed path id is a 400 before any SQL (a counter on the `sql` boundary sees no query from the route);
 *   - page=abc / limit=-1 / offset=-1 are a 400 naming the parameter (Number('abc') used to reach SQL as NaN);
 *   - known refusals keep their 4xx and say what was refused: a duplicate plan code is 409, redelivering a
 *     disabled webhook is 409 (both used to be "Failed ..." 400s).
 * Tokens are aal2; GoTrue is not called. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import announcementsRoute from '../../pages/api/admin/announcements';
import usersRoute from '../../pages/api/admin/users';
import emailLogRoute from '../../pages/api/admin/email-log';
import jobQueueRoute from '../../pages/api/admin/job-queue';
import planRoute from '../../pages/api/admin/billing/plans/[id]';
import plansRoute from '../../pages/api/admin/billing/plans';
import walletRoute from '../../pages/api/admin/billing/payg/[companyId]/wallet';
import companyUsersRoute from '../../pages/api/admin/companies/[id]/users';
import redeliverRoute from '../../pages/api/admin/webhooks/[id]/redeliver';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

/** `sql` calls made while `counting` is on (the route's own queries; the auth gate does not use `sql`). */
const probe = vi.hoisted(() => ({ counting: false, calls: 0 }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (probe.counting) probe.calls += 1;
    return realSql(strings, ...values);
  }, realSql);
  return { ...real, sql };
});
/** createAnnouncement writes its row, then fails: an unexpected error after a write. */
const failAfterWrite = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/admin/services/announcementService', async (orig) => {
  const actual = await orig<typeof import('@/modules/admin/services/announcementService')>();
  return {
    ...actual,
    createAnnouncement: async (...args: Parameters<typeof actual.createAnnouncement>) => {
      const id = await actual.createAnnouncement(...args);
      if (failAfterWrite.on) throw new Error('wp14b: failed after the write');
      return id;
    },
  };
});

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const webhook = crypto.randomUUID();
const TAG = `wp14b-${Date.now()}`;

type Route = (req: never, res: never) => Promise<unknown>;
type Body = { success?: boolean; message?: string; error?: { code?: string; message?: string } };
async function call(route: unknown, method: string, query: Record<string, string>, body?: unknown, url = '/api/admin/x') {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.query = query;
  req.body = body;
  req.url = url;
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
async function counted(fn: () => Promise<{ status: number; body: Body }>) {
  probe.calls = 0;
  probe.counting = true;
  try { return { ...(await fn()), sqlCalls: probe.calls }; } finally { probe.counting = false; }
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, `${TAG} co`]);
  await pool.query(`INSERT INTO webhook_endpoints (id, company_id, name, url, secret, events, is_active)
    VALUES ($1, $2, 'wp14b', 'https://example.test/hook', 'wp14b-secret', ARRAY['invoice.created'], false)`, [webhook, company]);
  await pool.query(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ($1, 'WP14b plan', 0)`, [`${TAG}-plan`]);
}, 60000);
beforeEach(() => { failAfterWrite.on = false; });
afterAll(async () => {
  try {
    await pool.query(`DELETE FROM system_announcements WHERE title LIKE $1`, [`${TAG}%`]);
    await pool.query('DELETE FROM webhook_endpoints WHERE id = $1', [webhook]);
    await pool.query('DELETE FROM plans WHERE code LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('section 6: an unexpected error is a 500 that rolls back', () => {
  it('POST announcements failing after its INSERT: 500, the row is gone, the attempt is recorded', async () => {
    failAfterWrite.on = true;
    const title = `${TAG} rolled back`;
    const r = await call(announcementsRoute, 'POST', {}, { title, message: 'm', starts_at: new Date().toISOString() },
      '/api/admin/announcements');
    expect(r.status).toBe(500);
    expect((await pool.query('SELECT count(*)::int AS n FROM system_announcements WHERE title = $1', [title])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = 'admin_request_failed'`, [admin])).rows[0].n).toBeGreaterThan(0);
  });
});

describe('section 6: a malformed id is a 400 before any SQL', () => {
  it.each([
    ['billing/plans/[id]', planRoute, { id: 'not-a-uuid' }],
    ['billing/payg/[companyId]/wallet', walletRoute, { companyId: '1; drop' }],
    ['companies/[id]/users', companyUsersRoute, { id: '123' }],
  ])('%s', async (_name, route, query) => {
    const r = await counted(() => call(route, 'GET', query as Record<string, string>));
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/^Invalid /);
    expect(r.sqlCalls).toBe(0);
  });
});

describe('section 6: garbage paging is a 400 naming the parameter', () => {
  it.each([
    ['users page=abc', usersRoute, { page: 'abc' }, /page/],
    ['users limit=-1', usersRoute, { limit: '-1' }, /limit/],
    ['email-log page=abc', emailLogRoute, { page: 'abc' }, /page/],
    ['job-queue offset=-1', jobQueueRoute, { offset: '-1' }, /offset/],
  ])('%s', async (_name, route, query, named) => {
    const r = await counted(() => call(route, 'GET', query as Record<string, string>));
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(named);
    expect(r.sqlCalls).toBe(0);
  });

  it('valid paging still answers 200', async () => {
    expect((await call(usersRoute, 'GET', { page: '1', limit: '5' })).status).toBe(200);
  });
});

describe('section 6: known refusals keep their 4xx and say what was refused', () => {
  it('a duplicate plan code is 409', async () => {
    const r = await call(plansRoute, 'POST', {}, { code: `${TAG}-plan`, name: 'dup', monthly_price_cents: 0 }, '/api/admin/billing/plans');
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toMatch(/already exists/);
  });

  it('redelivering a disabled webhook is 409', async () => {
    const r = await call(redeliverRoute, 'POST', { id: webhook }, {}, `/api/admin/webhooks/${webhook}/redeliver`);
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toMatch(/disabled/);
  });
});
