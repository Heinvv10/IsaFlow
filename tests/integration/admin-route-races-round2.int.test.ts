/**
 * PR #1405 review + breaker round 2 (WP14b), through the real admin stack on the disposable fixture.
 *
 *   - two concurrent DELETEs of one webhook / one user: one 200 and one audit row, the other a 404. Both requests
 *     are held at a barrier just before the statement that decides, so both have read the row first (they used to
 *     answer [200, 200] with two audit rows, though the second deleted nothing);
 *   - a DELETE of something that is not there is a 404 with no audit row (announcements/[id]; a company feature
 *     override that does not exist);
 *   - a bulk action naming the same id twice is a 400 that writes nothing (extend_trial extended the trial twice,
 *     suspend wrote two audit rows);
 *   - subscriptions/[id] PATCH with an unknown plan_id is a 400 before anything is written: reactivating a
 *     cancelled subscription voids its open charges and restarts its period first, and a 4xx would commit those.
 * Tokens are aal2; GoTrue is not called. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import webhookRoute from '../../pages/api/admin/webhooks/[id]';
import userRoute from '../../pages/api/admin/users/[id]';
import announcementRoute from '../../pages/api/admin/announcements/[id]';
import companyFeaturesRoute from '../../pages/api/admin/companies/[id]/features';
import companyBulkRoute from '../../pages/api/admin/companies/bulk-action';
import jobBulkRoute from '../../pages/api/admin/job-queue/bulk-action';
import subscriptionRoute from '../../pages/api/admin/billing/subscriptions/[id]';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

/**
 * `sql` with two hooks: statements are recorded while `recording`, and a statement matching `barrier.match` waits
 * until `barrier.need` of them have arrived (then all go on), so concurrent requests reach it together.
 */
const probe = vi.hoisted(() => ({
  recording: false, texts: [] as string[],
  barrier: null as null | { match: RegExp; need: number; arrived: number; open: () => void; opened: Promise<void> },
}));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').trim();
    if (probe.recording) probe.texts.push(text);
    const b = probe.barrier;
    if (b && b.match.test(text)) {
      b.arrived += 1;
      if (b.arrived >= b.need) b.open();
      await Promise.race([b.opened, new Promise((_, reject) => setTimeout(() => reject(new Error('barrier timeout')), 10000))]);
    }
    return realSql(strings, ...values);
  }, realSql);
  return { ...real, sql };
});
function setBarrier(match: RegExp, need = 2) {
  let open = () => undefined as void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  probe.barrier = { match, need, arrived: 0, open, opened };
}

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const job = crypto.randomUUID();
const TAG = `wp14b-r3-${Date.now()}`;

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
const auditRows = (targetId: string, action?: string) => action
  ? n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1 AND action = $2', [targetId, action])
  : n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1', [targetId]);

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name, status) VALUES ($1, $2, 'active')`, [company, `${TAG} co`]);
  await pool.query(`INSERT INTO background_jobs (id, job_type, status) VALUES ($1, $2, 'failed')`, [job, TAG]);
}, 60000);
beforeEach(async () => {
  probe.barrier = null; probe.recording = false; probe.texts = [];
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM background_jobs WHERE job_type = $1', [TAG]);
    await pool.query('DELETE FROM webhook_endpoints WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM plans WHERE code LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('two concurrent DELETEs: one deletes and is audited, the other is a 404', () => {
  it('webhooks/[id]', async () => {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO webhook_endpoints (id, company_id, name, url, secret, events, is_active)
      VALUES ($1, $2, 'r', 'https://example.test/h', 's', ARRAY['invoice.created'], true)`, [id, company]);
    setBarrier(/^DELETE FROM webhook_endpoints/i);
    const rs = await Promise.all([call(webhookRoute, 'DELETE', { id }), call(webhookRoute, 'DELETE', { id })]);
    expect(probe.barrier!.arrived).toBe(2);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await auditRows(id, 'webhook.delete')).toBe(1);
  });

  it('users/[id]', async () => {
    const id = `${TAG}-user`;
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
    setBarrier(/^SELECT role FROM users WHERE id/i);
    const rs = await Promise.all([call(userRoute, 'DELETE', { id }), call(userRoute, 'DELETE', { id })]);
    expect(probe.barrier!.arrived).toBe(2);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await auditRows(id, 'user.delete')).toBe(1);
  });
});

describe('a DELETE of something that is not there is a 404 with no audit row', () => {
  it('announcements/[id]', async () => {
    const id = crypto.randomUUID();
    expect((await call(announcementRoute, 'DELETE', { id })).status).toBe(404);
    expect(await auditRows(id)).toBe(0);
  });

  it('companies/[id]/features: no override for that feature', async () => {
    const r = await call(companyFeaturesRoute, 'DELETE', { id: company }, { feature_id: crypto.randomUUID() });
    expect(r.status).toBe(404);
    expect(await auditRows(company)).toBe(0);
  });
});

describe('a bulk action naming the same id twice is a 400 that writes nothing', () => {
  it('companies extend_trial: the trial is not extended', async () => {
    const before = (await pool.query('SELECT trial_ends_at FROM companies WHERE id = $1', [company])).rows[0];
    const r = await call(companyBulkRoute, 'POST', {}, { action: 'extend_trial', company_ids: [company, company.toUpperCase()], days: 10 });
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/more than once/);
    expect((await pool.query('SELECT trial_ends_at FROM companies WHERE id = $1', [company])).rows[0]).toEqual(before);
  });

  it('companies suspend: still active, no audit row', async () => {
    const r = await call(companyBulkRoute, 'POST', {}, { action: 'suspend', company_ids: [company, company], reason: 'wp14b test' });
    expect(r.status).toBe(400);
    expect((await pool.query('SELECT status FROM companies WHERE id = $1', [company])).rows[0].status).toBe('active');
    expect(await auditRows(company)).toBe(0);
  });

  it('job-queue retry: the job stays failed', async () => {
    const r = await call(jobBulkRoute, 'POST', {}, { action: 'retry', ids: [job, job] });
    expect(r.status).toBe(400);
    expect((await pool.query('SELECT status FROM background_jobs WHERE id = $1', [job])).rows[0].status).toBe('failed');
  });
});

describe('subscriptions/[id] PATCH with an unknown plan_id', () => {
  it('reactivating a cancelled subscription: 400, nothing written', async () => {
    const plan = (await pool.query(`INSERT INTO plans (code, name, monthly_price_cents) VALUES ($1, 'p', 0) RETURNING id`,
      [`${TAG}-plan`])).rows[0].id as string;
    const sub = (await pool.query(`INSERT INTO subscriptions (company_id, plan_id, status, billing_cycle, current_period_start,
      current_period_end, cancelled_at) VALUES ($1, $2, 'cancelled', 'monthly', '2026-01-01', '2026-02-01', '2026-01-15') RETURNING id`,
    [company, plan])).rows[0].id as string;
    const before = (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [sub])).rows[0];
    probe.recording = true;
    const r = await call(subscriptionRoute, 'PATCH', { id: sub }, { status: 'active', plan_id: crypto.randomUUID() });
    probe.recording = false;
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/plan/i);
    expect(probe.texts.filter((t) => /^UPDATE\b/i.test(t))).toEqual([]);
    expect((await pool.query('SELECT * FROM subscriptions WHERE id = $1', [sub])).rows[0]).toEqual(before);
    expect(await auditRows(sub)).toBe(0);
  });
});
