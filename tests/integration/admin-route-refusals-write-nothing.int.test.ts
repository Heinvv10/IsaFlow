/**
 * PR #1405 review + breaker round (WP14b): a refused admin request writes nothing, through the real admin stack
 * (withAdmin, withPlatformAdmin on platform_admin, withErrorHandler) on the disposable fixture.
 *
 *   - a missing target is a 404 BEFORE the write and the audit row: a request transaction commits on any answer
 *     below 500, so a 200 (or 404) after an UPDATE that matched nothing used to commit an audit row about nothing
 *     (features/[id] PATCH, users/[id]/activate, plans/[id] PATCH + DELETE, subscriptions/[id]/cancel);
 *   - webhooks/[id] PATCH on a missing webhook issues no UPDATE at all (existence checked first);
 *   - a create naming a missing parent is a 4xx with nothing written (company POST with an unknown plan: 400, no
 *     company row; PAYG adjust for a missing company: 404; subscription POST for a missing company: 400);
 *   - a bulk action that hits an unexpected error is a 500 that rolls back the items before it (it used to report
 *     the failure in errors[] with a 200, committing the items before it);
 *   - concurrent duplicate plan creates: one row, one audit row, the rest 409.
 * Tokens are aal2; GoTrue is not called. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import featureRoute from '../../pages/api/admin/features/[id]';
import activateRoute from '../../pages/api/admin/users/[id]/activate';
import planRoute from '../../pages/api/admin/billing/plans/[id]';
import plansRoute from '../../pages/api/admin/billing/plans';
import subsRoute from '../../pages/api/admin/billing/subscriptions';
import cancelRoute from '../../pages/api/admin/billing/subscriptions/[id]/cancel';
import webhookRoute from '../../pages/api/admin/webhooks/[id]';
import companiesRoute from '../../pages/api/admin/companies';
import adjustRoute from '../../pages/api/admin/billing/payg/[companyId]/adjust';
import companyBulkRoute from '../../pages/api/admin/companies/bulk-action';
import jobBulkRoute from '../../pages/api/admin/job-queue/bulk-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

/** Statements the route sends through `sql` while recording; `failOn` makes a statement binding that value throw. */
const probe = vi.hoisted(() => ({ recording: false, texts: [] as string[], failOn: '' }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (probe.recording) probe.texts.push(strings.join('?').trim());
    if (probe.failOn && values.includes(probe.failOn)) return Promise.reject(new Error('wp14b: unexpected failure'));
    return realSql(strings, ...values);
  }, realSql);
  return { ...real, sql };
});

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const coA = crypto.randomUUID();
const coB = crypto.randomUUID();
const jobA = crypto.randomUUID();
const jobB = crypto.randomUUID();
const TAG = `wp14b-r2-${Date.now()}`;

type Route = (req: never, res: never) => Promise<unknown>;
type Body = { success?: boolean; error?: { code?: string; message?: string } };
async function call(route: unknown, method: string, query: Record<string, string>, body?: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method) as unknown as { body: unknown; url: string; query: Record<string, string> };
  req.query = query;
  req.body = body;
  req.url = '/api/admin/x';
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
const n = async (text: string, params: unknown[]) => (await pool.query(text, params)).rows[0].n as number;
const auditRows = (targetId: string) => n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1', [targetId]);

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name, status) VALUES ($1, $2, 'active'), ($3, $4, 'active')`,
    [coA, `${TAG} a`, coB, `${TAG} b`]);
  await pool.query(`INSERT INTO background_jobs (id, job_type, status) VALUES ($1, $3, 'failed'), ($2, $3, 'failed')`,
    [jobA, jobB, TAG]);
}, 60000);
beforeEach(() => { probe.failOn = ''; probe.recording = false; probe.texts = []; });
afterAll(async () => {
  try {
    await pool.query('DELETE FROM background_jobs WHERE job_type = $1', [TAG]);
    await pool.query('DELETE FROM subscriptions WHERE company_id IN (SELECT id FROM companies WHERE name LIKE $1)', [`${TAG}%`]);
    await pool.query('DELETE FROM companies WHERE name LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM plans WHERE code LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('a missing target is a 404 before the write and the audit row', () => {
  it.each([
    ['features/[id] PATCH', featureRoute, 'PATCH', { name: 'ghost' }],
    ['users/[id]/activate POST', activateRoute, 'POST', undefined],
    ['billing/plans/[id] PATCH', planRoute, 'PATCH', { name: 'ghost' }],
    ['billing/plans/[id] DELETE', planRoute, 'DELETE', undefined],
    ['billing/subscriptions/[id]/cancel now', cancelRoute, 'POST', { at_period_end: false }],
    ['billing/subscriptions/[id]/cancel at period end', cancelRoute, 'POST', { at_period_end: true }],
  ])('%s', async (_name, route, method, body) => {
    const id = crypto.randomUUID();
    const r = await call(route, method, { id }, body);
    expect(r.status).toBe(404);
    expect(await auditRows(id)).toBe(0);
  });

  it('webhooks/[id] PATCH on a missing webhook: 404, no UPDATE issued, no audit row', async () => {
    const id = crypto.randomUUID();
    probe.recording = true;
    const r = await call(webhookRoute, 'PATCH', { id }, { status: 'active', url: 'https://example.test/x' });
    probe.recording = false;
    expect(r.status).toBe(404);
    expect(probe.texts.filter((t) => /^UPDATE\b/i.test(t))).toEqual([]);
    expect(await auditRows(id)).toBe(0);
  });
});

describe('a create naming a missing parent writes nothing', () => {
  it('companies POST with an unknown plan_id: 400 and no company row', async () => {
    const name = `${TAG} unknown plan`;
    const r = await call(companiesRoute, 'POST', {}, { name, plan_id: crypto.randomUUID() });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/plan/i);
    expect(await n('SELECT count(*)::int n FROM companies WHERE name = $1', [name])).toBe(0);
  });

  it('PAYG adjust for a missing company: 404 and no wallet row', async () => {
    const id = crypto.randomUUID();
    const r = await call(adjustRoute, 'POST', { companyId: id }, { flows: 5, reason: 'wp14b test' });
    expect(r.status).toBe(404);
    expect(await n('SELECT count(*)::int n FROM flow_wallet WHERE company_id = $1', [id])).toBe(0);
    expect(await auditRows(id)).toBe(0);
  });

  it('subscriptions POST for a missing company: 400 and no subscription row', async () => {
    const plan = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ($1, 'p', 0) RETURNING id`,
      [`${TAG}-sub`])).rows[0].id as string;
    const company = crypto.randomUUID();
    const r = await call(subsRoute, 'POST', {}, { company_id: company, plan_id: plan, billing_cycle: 'monthly' });
    expect(r.status).toBe(400);
    expect(await n('SELECT count(*)::int n FROM subscriptions WHERE company_id = $1', [company])).toBe(0);
  });
});

describe('a bulk action hitting an unexpected error is a 500 that rolls back the earlier items', () => {
  it('companies bulk suspend: the first company stays active', async () => {
    probe.failOn = coB;
    const r = await call(companyBulkRoute, 'POST', {}, { action: 'suspend', company_ids: [coA, coB], reason: 'wp14b test' });
    expect(r.status).toBe(500);
    expect((await pool.query('SELECT status FROM companies WHERE id = $1', [coA])).rows[0].status).toBe('active');
    expect(await auditRows(coA)).toBe(0);
  });

  it('job-queue bulk retry: the first job stays failed', async () => {
    probe.failOn = jobB;
    const r = await call(jobBulkRoute, 'POST', {}, { action: 'retry', ids: [jobA, jobB] });
    expect(r.status).toBe(500);
    expect((await pool.query('SELECT status FROM background_jobs WHERE id = $1', [jobA])).rows[0].status).toBe('failed');
  });

  it('a known per-item refusal is still a 200 listing it (a missing company)', async () => {
    const ghost = crypto.randomUUID();
    const r = await call(companyBulkRoute, 'POST', {}, { action: 'suspend', company_ids: [ghost], reason: 'wp14b test' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain(`${ghost}: not found or deleted`);
  });
});

describe('concurrent duplicate plan creates', () => {
  it('one row, one audit row, the others 409', async () => {
    const code = `${TAG}-race`;
    const rs = await Promise.all([1, 2, 3].map(() => call(plansRoute, 'POST', {}, { code, name: 'r', monthly_price_cents: 0 })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await n('SELECT count(*)::int n FROM plans WHERE code = $1', [code])).toBe(1);
    expect(await n(`SELECT count(*)::int n FROM admin_audit_log WHERE action = 'plan.create' AND details->>'code' = $1`, [code])).toBe(1);
  });
});
