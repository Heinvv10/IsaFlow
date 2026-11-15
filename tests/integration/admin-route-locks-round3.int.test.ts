/**
 * PR #1405 breaker + review round 3 (WP14b), through the real admin stack on the disposable fixture.
 *
 *   - D1: deleting a user while their onboarding is reset (or they are removed from a company) never deadlocks.
 *     deleteUser held the users row and wanted company_users; resetOnboarding held company_users and wanted the
 *     users row: 40P01 in 5 of 6 runs. Both now take the users row first. Each pair is held at a barrier at the
 *     statement each takes its SECOND lock with (released after both arrive, or after 1.5 s when the lock order
 *     keeps one from getting there), so the old interleaving is forced every run.
 *   - D2: reset-onboarding for a missing user is a 404 with no audit row (it was 200 {reset:true} plus a row).
 *   - D6: force-logout for a missing user is a 404 before GoTrue is called and with no audit row.
 *   - D3/D4: a lone UTF-16 surrogate in a body string or key is a 400 (jsonb refused it: a 500), and the field path
 *     in the message is capped at 200 characters.
 * Tokens are aal2; GoTrue is a stubbed fetch. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import userRoute from '../../pages/api/admin/users/[id]';
import resetOnboardingRoute from '../../pages/api/admin/users/[id]/reset-onboarding';
import removeFromCompanyRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import forceLogoutRoute from '../../pages/api/admin/users/[id]/force-logout';
import plansRoute from '../../pages/api/admin/billing/plans';
import announcementsRoute from '../../pages/api/admin/announcements';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

/** A statement matching `barrier.match` waits until `need` have arrived or `maxMs` passed, then all go on. */
const probe = vi.hoisted(() => ({
  barrier: null as null | { match: RegExp; need: number; arrived: number; open: () => void; opened: Promise<void> },
}));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const b = probe.barrier;
    if (b && b.match.test(strings.join('?').trim())) {
      b.arrived += 1;
      if (b.arrived >= b.need) b.open();
      await Promise.race([b.opened, new Promise((resolve) => setTimeout(resolve, 1500))]);
    }
    return realSql(strings, ...values);
  }, realSql);
  return { ...real, sql };
});
function setBarrier(match: RegExp) {
  let open = () => undefined as void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  probe.barrier = { match, need: 2, arrived: 0, open, opened };
}

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
  probe.barrier = null;
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

/** Each answer is a 200 with its one audit row or a 404 with none; never a 5xx (a deadlock is a 500/503). */
async function expectCoherent(userId: string, rs: Array<{ status: number }>, actions: [string, string]) {
  expect(rs.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
  for (const [i, r] of rs.entries()) {
    const rows = await n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1 AND action = $2', [userId, actions[i]]);
    expect([r.status, rows]).toEqual(r.status === 200 ? [200, 1] : [404, 0]);
  }
  expect(await n('SELECT count(*)::int n FROM users WHERE id = $1', [userId])).toBe(0);
}

describe('D1: a user DELETE racing another writer of the same user never deadlocks', () => {
  it.each([1, 2, 3])('DELETE vs reset-onboarding, run %i', async () => {
    const u = await member();
    setBarrier(/^(DELETE FROM company_users WHERE user_id|UPDATE users\s+SET onboarding_completed)/i);
    const rs = await Promise.all([call(userRoute, 'DELETE', { id: u }), call(resetOnboardingRoute, 'POST', { id: u })]);
    await expectCoherent(u, rs, ['user.delete', 'user.reset_onboarding']);
  }, 20000);

  it.each([1, 2, 3])('DELETE vs remove-from-company, run %i', async () => {
    const u = await member();
    setBarrier(/^DELETE FROM company_users/i);
    const rs = await Promise.all([
      call(userRoute, 'DELETE', { id: u }),
      call(removeFromCompanyRoute, 'DELETE', { id: u }, { company_id: company }),
    ]);
    expect(rs.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
    expect(rs[0]!.status).toBe(200);
    expect(await n('SELECT count(*)::int n FROM users WHERE id = $1', [u])).toBe(0);
  }, 20000);
});

describe('D2 / D6: a missing user is a 404 before anything is written, called or audited', () => {
  it('reset-onboarding', async () => {
    const ghost = `${TAG}-ghost-reset`;
    expect((await call(resetOnboardingRoute, 'POST', { id: ghost })).status).toBe(404);
    expect(await auditRows(ghost)).toBe(0);
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
