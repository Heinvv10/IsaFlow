/**
 * The tenant side of system announcements (admin audit 1.4): GET /api/announcements/active and
 * POST /api/announcements/dismiss, called as real members through withAuth (request transaction, GUCs,
 * app_user role) against the disposable schema fixture.
 *
 * Holds: the starts_at / ends_at window, the three targets (all / plan / company) judged against the
 * CALLER'S active company, another tenant's announcement never reaching this one (and its target ids
 * never printed), and a dismissal that is per user, per announcement, and refused for an announcement the
 * admin marked not dismissible.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import activeRoute from '../../pages/api/announcements/active';
import dismissRoute from '../../pages/api/announcements/dismiss';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { fakeGotrueFetch, signSession, type FakeGotrue } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const TAG = `ANN-${Date.now()}`;
const ADMIN = crypto.randomUUID();

interface Member { userId: string; companyId: string; token: string }
const companies: string[] = [];
const users: string[] = [];
const plans: string[] = [];

async function member(companyId: string): Promise<Member> {
  const userId = crypto.randomUUID();
  await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`,
    [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`,
    [companyId, userId]);
  users.push(userId);
  return { userId, companyId, token: await signSession(userId, undefined, 'aal2') };
}
async function newCompany(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [id, `${TAG} ${id}`]);
  companies.push(id);
  return id;
}
async function newPlan(): Promise<string> {
  const r = await pool.query(`INSERT INTO plans (code, name) VALUES ($1, $1) RETURNING id`, [`${TAG}-${crypto.randomUUID().slice(0, 8)}`]);
  plans.push(r.rows[0].id as string);
  return r.rows[0].id as string;
}
const subscribe = (companyId: string, planId: string, status: string) =>
  pool.query(`INSERT INTO subscriptions (company_id, plan_id, status) VALUES ($1, $2, $3)`, [companyId, planId, status]);

interface Seed { title: string; target?: string; ids?: string[]; starts?: string; ends?: string | null; dismissible?: boolean }
async function seed(s: Seed): Promise<string> {
  const r = await pool.query(
    `INSERT INTO system_announcements (title, message, type, target, target_ids, starts_at, ends_at, is_dismissible, created_by)
     VALUES ($1, $2, 'info', $3, $4::uuid[], COALESCE($5::timestamptz, NOW() - interval '1 hour'), $6::timestamptz, $7, $8) RETURNING id`,
    [`${TAG} ${s.title}`, `msg ${s.title}`, s.target ?? 'all', s.ids ?? [], s.starts ?? null, s.ends ?? null, s.dismissible ?? true, ADMIN]);
  return r.rows[0].id as string;
}

async function call(route: unknown, m: Member, method: string, body?: unknown) {
  const req = request({ 'sb-access-token': m.token, active_company_id: m.companyId }, method) as unknown as
    { url: string; query: unknown; body: unknown };
  req.url = '/api/announcements/x';
  req.query = {};
  req.body = body;
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as { data?: unknown; error?: unknown } };
}
type Row = { id: string; title: string; message: string; is_dismissible: boolean };
async function titles(m: Member): Promise<string[]> {
  const r = await call(activeRoute, m, 'GET');
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  return (r.body.data as Row[]).filter(a => a.title.startsWith(TAG)).map(a => a.title.slice(TAG.length + 1)).sort();
}

let a: Member, a2: Member, b: Member, c: Member;
let planP1: string, planP2: string, planOther: string;

beforeAll(async () => {
  const [ca, cb, cc] = [await newCompany(), await newCompany(), await newCompany()];
  [planP1, planP2, planOther] = [await newPlan(), await newPlan(), await newPlan()];
  a = await member(ca);
  a2 = await member(ca);
  b = await member(cb);
  c = await member(cc);
  await subscribe(ca, planP1, 'active');
  await subscribe(ca, planP2, 'trial'); // two live subscriptions: a plan target must match either
  await subscribe(cb, planOther, 'active');
  await subscribe(cc, planP1, 'cancelled'); // a cancelled plan is not the company's plan
  // The one fixture row: the id of company A's ... see the assertions below
  await seed({ title: 'all-open' });
  await seed({ title: 'all-window', ends: new Date(Date.now() + 3600_000).toISOString() });
  await seed({ title: 'ended', ends: new Date(Date.now() - 60_000).toISOString() });
  await seed({ title: 'future', starts: new Date(Date.now() + 3600_000).toISOString() });
  await seed({ title: 'company-a', target: 'company', ids: [ca] });
  await seed({ title: 'company-a-and-b', target: 'company', ids: [ca, cb] });
  await seed({ title: 'company-b-only', target: 'company', ids: [cb] });
  await seed({ title: 'company-empty', target: 'company', ids: [] });
  await seed({ title: 'plan-p1', target: 'plan', ids: [planP1] });
  await seed({ title: 'plan-p2', target: 'plan', ids: [planP2] });
  await seed({ title: 'plan-other', target: 'plan', ids: [planOther] });
  await seed({ title: 'plan-empty', target: 'plan', ids: [] });
  await seed({ title: 'sticky', dismissible: false });
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM user_preferences WHERE user_id = ANY($1::text[])', [users]);
    await pool.query('DELETE FROM system_announcements WHERE created_by = $1', [ADMIN]);
    await pool.query('DELETE FROM subscriptions WHERE company_id = ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM plans WHERE id = ANY($1::uuid[])', [plans]);
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::text[])', [users]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
}, 60000);

describe('GET /api/announcements/active', () => {
  it('window: an open-ended and an in-window announcement show; an ended one and a future one do not', async () => {
    const seen = await titles(a);
    expect(seen).toContain('all-open');
    expect(seen).toContain('all-window');
    expect(seen).not.toContain('ended');
    expect(seen).not.toContain('future');
  });

  it('company target: only a listed company sees it; an empty list reaches nobody', async () => {
    expect(await titles(a)).toEqual(expect.arrayContaining(['company-a', 'company-a-and-b']));
    expect(await titles(a)).not.toContain('company-b-only');
    expect(await titles(a)).not.toContain('company-empty');
    expect(await titles(b)).toEqual(expect.arrayContaining(['company-a-and-b', 'company-b-only']));
    expect(await titles(b)).not.toContain('company-a');
    expect(await titles(c)).not.toContain('company-a');
    expect(await titles(c)).not.toContain('company-a-and-b');
  });

  it('plan target: matches the company\'s active or trial plan (either of two), never another plan, a cancelled one or an empty list', async () => {
    const seenA = await titles(a);
    expect(seenA).toEqual(expect.arrayContaining(['plan-p1', 'plan-p2']));
    expect(seenA).not.toContain('plan-other');
    expect(seenA).not.toContain('plan-empty');
    const seenB = await titles(b);
    expect(seenB).toContain('plan-other');
    expect(seenB).not.toContain('plan-p1');
    const seenC = await titles(c);
    expect(seenC).not.toContain('plan-p1');
    expect(seenC).not.toContain('plan-other');
  });

  it('is judged by the ACTIVE company, not by any company the user belongs to', async () => {
    // a2 also belongs to B but has A active: B's announcement must not appear.
    await pool.query(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', false)`, [b.companyId, a2.userId]);
    expect(await titles(a2)).not.toContain('company-b-only');
    const asB = { ...a2, companyId: b.companyId };
    expect(await titles(asB)).toContain('company-b-only');
    expect(await titles(asB)).not.toContain('company-a');
  });

  it('prints nothing about other tenants or admins: no target_ids, no created_by, no other company id anywhere', async () => {
    const r = await call(activeRoute, a, 'GET');
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(b.companyId);
    expect(text).not.toContain(ADMIN);
    for (const row of r.body.data as Record<string, unknown>[]) {
      expect(Object.keys(row)).not.toContain('target_ids');
      expect(Object.keys(row)).not.toContain('created_by');
    }
  });

  it('needs a session', async () => {
    const out = response();
    const req = request({}, 'GET') as unknown as { url: string; query: unknown };
    req.url = '/api/announcements/active';
    req.query = {};
    await (activeRoute as unknown as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(401);
  });
});

describe('POST /api/announcements/dismiss', () => {
  const idOf = async (title: string) =>
    (await pool.query('SELECT id FROM system_announcements WHERE title = $1 AND created_by = $2', [`${TAG} ${title}`, ADMIN])).rows[0].id as string;

  it('hides it for that user only (same company, other user still sees it), and a second dismissal is harmless', async () => {
    const id = await idOf('all-window');
    expect((await call(dismissRoute, a, 'POST', { id })).status).toBe(200);
    expect(await titles(a)).not.toContain('all-window');
    expect(await titles(a2)).toContain('all-window');
    expect(await titles(b)).toContain('all-window');
    expect((await call(dismissRoute, a, 'POST', { id })).status).toBe(200);
    expect(await titles(a)).not.toContain('all-window');
  });

  it('refuses a not-dismissible announcement and it stays visible', async () => {
    const id = await idOf('sticky');
    expect((await call(dismissRoute, a, 'POST', { id })).status).toBe(400);
    expect(await titles(a)).toContain('sticky');
  });

  it('a hand-written preference key cannot hide a not-dismissible announcement either', async () => {
    const id = await idOf('sticky');
    await pool.query(`INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, 'true')`, [a2.userId, `announcement_dismissed:${id}`]);
    expect(await titles(a2)).toContain('sticky');
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    expect((await call(dismissRoute, a, 'POST', { id: crypto.randomUUID() })).status).toBe(404);
    expect((await call(dismissRoute, a, 'POST', { id: 'not-a-uuid' })).status).toBe(400);
    expect((await call(dismissRoute, a, 'POST', {})).status).toBe(400);
  });

  it('a Login-as session leaves no dismissal under the target user\'s name: 403, nothing written, still shown', async () => {
    // A token with a session id makes withAuth ask GoTrue about the session: only that endpoint is faked.
    const gotrue: FakeGotrue = { nextSessionId: crypto.randomUUID(), minted: [] };
    vi.stubEnv('SUPABASE_ANON_KEY', 'ann-anon');
    vi.stubGlobal('fetch', fakeGotrueFetch((email) => email.split('@')[0]!, gotrue));
    const sessionId = crypto.randomUUID();
    await pool.query(`INSERT INTO impersonation_sessions (session_id, actor_user_id, target_user_id) VALUES ($1, $2, $3)`,
      [sessionId, b.userId, c.userId]);
    try {
      const viaLoginAs = { ...c, token: await signSession(c.userId, sessionId, 'aal1') };
      const id = await idOf('all-open');
      expect((await call(dismissRoute, viaLoginAs, 'POST', { id })).status).toBe(403);
      const n = await pool.query(`SELECT count(*)::int AS n FROM user_preferences WHERE user_id = $1`, [c.userId]);
      expect(n.rows[0].n).toBe(0);
      expect(await titles(c)).toContain('all-open');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await pool.query('DELETE FROM impersonation_sessions WHERE session_id = $1', [sessionId]);
    }
  });

  it('only an announcement that targets the caller can be dismissed: another company\'s, or another plan\'s, is a 404 and writes nothing', async () => {
    const before = async (m: Member) => Number((await pool.query('SELECT count(*) AS n FROM user_preferences WHERE user_id = $1', [m.userId])).rows[0].n);
    const n0 = await before(c);
    for (const title of ['company-a', 'plan-p1', 'plan-other', 'company-empty', 'company-b-only']) {
      const r = await call(dismissRoute, c, 'POST', { id: await idOf(title) });
      expect([title, r.status]).toEqual([title, 404]);
    }
    expect(await before(c)).toBe(n0);
    // The caller's own targets still work: company A for a, plan P1 and P2 (either live subscription) for a.
    for (const title of ['company-a', 'plan-p1', 'plan-p2', 'all-open']) {
      expect([title, (await call(dismissRoute, a2, 'POST', { id: await idOf(title) })).status]).toEqual([title, 200]);
    }
  });

  it('only POST', async () => {
    expect((await call(dismissRoute, a, 'GET')).status).toBe(405);
  });
});
