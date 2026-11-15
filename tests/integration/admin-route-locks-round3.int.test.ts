/**
 * PR #1405 breaker + review round 3 (WP14b), through the real admin stack on the disposable fixture.
 *
 *   - D2: reset-onboarding for a missing user is a 404 with no audit row (it was 200 {reset:true} plus a row).
 *   - D6: force-logout for a missing user is a 404 before GoTrue is called and with no audit row.
 *   - D3/D4: a lone UTF-16 surrogate in a body string or key is a 400 (jsonb refused it: a 500), and the field path
 *     in the message is capped at 200 characters.
 * The lock-order races (D1, E1) are tests/integration/admin-user-lock-order.int.test.ts.
 * Tokens are aal2; GoTrue is a stubbed fetch. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import resetOnboardingRoute from '../../pages/api/admin/users/[id]/reset-onboarding';
import userRoute from '../../pages/api/admin/users/[id]';
import forceLogoutRoute from '../../pages/api/admin/users/[id]/force-logout';
import plansRoute from '../../pages/api/admin/billing/plans';
import announcementsRoute from '../../pages/api/admin/announcements';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const TAG = `wp14b-r4-${Date.now()}`;
let seq = 0;

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
async function member() {
  const id = `${TAG}-u${seq++}`;
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, id]);
  return id;
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2)`, [company, `${TAG} co`]);
}, 60000);
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
});
afterAll(async () => {
  vi.unstubAllGlobals();
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM users WHERE id LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM plans WHERE code LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM system_announcements WHERE title LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM companies WHERE id = $1', [company]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

describe('D2 / D6: a missing user is a 404 before anything is written, called or audited', () => {
  it('reset-onboarding: an orphan membership under that id survives the 404 (review #1405 round 5, L3)', async () => {
    const ghost = `${TAG}-ghost-reset`;
    // company_users.user_id has no foreign key to users: an orphan row for a missing user can exist.
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, ghost]);
    expect((await call(resetOnboardingRoute, 'POST', { id: ghost })).status).toBe(404);
    expect(await auditRows(ghost)).toBe(0);
    expect(await n('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [ghost])).toBe(1);
  });

  it('DELETE user: the same orphan survives its 404', async () => {
    const ghost = `${TAG}-ghost-delete`;
    await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, ghost]);
    expect((await call(userRoute, 'DELETE', { id: ghost })).status).toBe(404);
    expect(await auditRows(ghost)).toBe(0);
    expect(await n('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [ghost])).toBe(1);
  });

  it('force-logout: GoTrue is not called', async () => {
    const ghost = `${TAG}-ghost-logout`;
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(forceLogoutRoute, 'POST', { id: ghost })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await auditRows(ghost)).toBe(0);
  });

  it('force-logout of a real user still logs them out (200, audited)', async () => {
    const u = await member();
    vi.stubEnv('SUPABASE_ANON_KEY', 'test'); // GoTrue itself is the stubbed fetch (204)
    try {
      expect((await call(forceLogoutRoute, 'POST', { id: u })).status).toBe(200);
    } finally { vi.unstubAllEnvs(); }
    expect(await auditRows(u)).toBe(1);
  });
});

describe('D3 / D4: text Postgres cannot store is a 400 naming the field', () => {
  it.each([
    ['a lone high surrogate in a plan name', plansRoute, { code: `${TAG}-s1`, name: 'x\ud800', monthly_price_cents: 0 }, /^name .*surrogate/],
    ['a lone low surrogate inside plan features', plansRoute, { code: `${TAG}-s2`, name: 'x', monthly_price_cents: 0, features: { k: 'y\udc00' } }, /^features\.k .*surrogate/],
    ['a lone surrogate in a key', plansRoute, { code: `${TAG}-s3`, name: 'x', monthly_price_cents: 0, features: { ['k\ud800']: 'v' } }, /field name in features .*surrogate/],
    ['a lone surrogate in an announcement title', announcementsRoute, { title: `${TAG} \ud800`, message: 'm', starts_at: '2026-11-20T08:00:00.000Z' }, /^title .*surrogate/],
  ])('%s', async (_name, route, body, named) => {
    const r = await call(route, 'POST', {}, body);
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(named);
    expect(await n('SELECT count(*)::int n FROM plans WHERE code LIKE $1', [`${TAG}%`])).toBe(0);
    expect(await n('SELECT count(*)::int n FROM system_announcements WHERE title LIKE $1', [`${TAG}%`])).toBe(0);
  });

  it('a well-formed emoji and a literal "\\u0000" (six characters) still save', async () => {
    const r = await call(plansRoute, 'POST', {}, { code: `${TAG}-ok`, name: 'tab\there \\u0000 é 😀', monthly_price_cents: 0 });
    expect(r.status).toBe(200);
    await pool.query('DELETE FROM plans WHERE code = $1', [`${TAG}-ok`]);
  });

  it('a deeply nested NUL: 400 with the path capped at 200 characters', async () => {
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 5000; i++) deep = { abcdefgh: deep };
    const r = await call(plansRoute, 'POST', {}, { code: `${TAG}-deep`, name: 'n', monthly_price_cents: 0, features: deep });
    expect(r.status).toBe(400);
    const message = r.body.error?.message ?? '';
    expect(message).toMatch(/^features\.abcdefgh\.abcdefgh.*\.\.\. must not contain a NUL character$/);
    expect(message.length).toBeLessThan(260);
  });
});
