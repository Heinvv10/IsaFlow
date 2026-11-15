/**
 * PR #1405 rounds 3-4 (WP14b): one lock order for a user's rows, company_users -> users -> user_sessions (the order
 * the tenant invite-accept routes use), so no admin writer deadlocks (40P01) against another writer of the same user.
 *
 * Each pair is held at a barrier placed right AFTER each request's FIRST row-lock statement: a request that took its
 * first lock waits there until the other has taken its own first lock too. Under one lock order the first locks are
 * on the same rows, so the second request cannot take its lock: it waits inside that statement, and the barrier lets
 * the first go on after 1.5 s (the pair is serialised, which is the point). Under two orders both first locks are
 * taken, both requests go on to their second lock at once, and Postgres reports the deadlock (a 5xx). Mutating one
 * writer to users-first turns these red.
 *
 *   - DELETE user vs reset-onboarding, vs remove-from-company, vs an invitation accept of an existing member (its SQL
 *     replayed statement for statement from pages/api/invitations/[token]/accept.ts, on its own connection).
 *   - E1: DELETE user vs add-to-company leaves no membership of a deleted user (company_users.user_id has no foreign
 *     key to users): add holds the user FOR KEY SHARE, so the DELETE FROM users waits for it, then sweeps. The add's
 *     commit is held until the delete answers, which forces the orphan whenever either half is missing.
 *   - E2: add-to-company for a user that does not exist is a 404 with no row and no audit row.
 * Tokens are aal2. Disposable fixture only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import userRoute from '../../pages/api/admin/users/[id]';
import resetOnboardingRoute from '../../pages/api/admin/users/[id]/reset-onboarding';
import removeFromCompanyRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import addToCompanyRoute from '../../pages/api/admin/users/[id]/add-to-company';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

/** A row-lock statement on a user's rows (what the barrier holds a request after). */
const LOCKING = /^(DELETE FROM|UPDATE|INSERT INTO)\s+(public\.)?(company_users|users|user_sessions)\b|\bFROM\s+(public\.)?(company_users|users)\b[\s\S]*\bFOR\s+(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/i;

const probe = vi.hoisted(() => ({
  barrier: null as null | { need: number; arrived: number; open: () => void; opened: Promise<void> },
  /** Holds add-to-company's audit INSERT (so its commit) until this settles, or 2.5 s pass. */
  holdAdd: null as null | Promise<unknown>,
}));
/** Wait at the barrier (after a first lock) until `need` requests arrived, or 1.5 s passed. */
async function arrive() {
  const b = probe.barrier;
  if (!b) return;
  b.arrived += 1;
  if (b.arrived >= b.need) b.open();
  await Promise.race([b.opened, new Promise((resolve) => setTimeout(resolve, 1500))]);
  b.open(); // whoever times out releases the rest: the barrier holds each request once
}
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (probe.holdAdd && values.includes('user.add_to_company')) {
      await Promise.race([probe.holdAdd, new Promise((resolve) => setTimeout(resolve, 2500))]);
    }
    const result = await realSql(strings, ...values);
    const b = probe.barrier;
    if (b && b.arrived < b.need && LOCKING.test(strings.join('?').trim())) await arrive();
    return result;
  }, realSql);
  return { ...real, sql };
});
function setBarrier() {
  let open = () => undefined as void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  probe.barrier = { need: 2, arrived: 0, open, opened };
}

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const admin = crypto.randomUUID();
const company = crypto.randomUUID();
const company2 = crypto.randomUUID();
const TAG = `wp14b-r5-${Date.now()}`;
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
const audits = (userId: string, action: string) =>
  n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1 AND action = $2', [userId, action]);
async function member() {
  const id = `${TAG}-u${seq++}`;
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, id]);
  return id;
}

/** pages/api/invitations/[token]/accept.ts step 4, statement for statement, for an existing member. */
async function replayInviteAccept(userId: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO company_users (company_id, user_id, role)
       VALUES ($1::uuid, $2, $3)
       ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role
         WHERE public.company_member_role_is_owner(company_users.role) IS NOT TRUE`,
      [company, userId, 'accountant']);
    await arrive(); // its first lock (the existing membership row) is held
    await client.query(
      `INSERT INTO users (id, email, first_name, last_name, is_active, onboarding_completed)
       VALUES ($1, $2, $3, $4, true, true)
       ON CONFLICT (id) DO UPDATE SET
         first_name = COALESCE(EXCLUDED.first_name, users.first_name),
         last_name  = COALESCE(EXCLUDED.last_name,  users.last_name),
         onboarding_completed = COALESCE(users.onboarding_completed, true)`,
      [userId, `${userId}@test.local`, null, null]);
    await client.query('COMMIT');
    return 'ok';
  } catch (err) {
    await client.query('ROLLBACK');
    return (err as { code?: string }).code ?? 'error';
  } finally { client.release(); }
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)`, [company, `${TAG} co`, company2, `${TAG} co2`]);
}, 60000);
beforeEach(async () => {
  probe.barrier = null;
  probe.holdAdd = null;
  await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, company2]]);
    await pool.query('DELETE FROM users WHERE id LIKE $1', [`${TAG}%`]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, company2]]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally { await pool.end(); }
});

const no5xx = (rs: Array<{ status: number }>) => expect(rs.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);

describe('one lock order: a user DELETE racing another writer of the same user never deadlocks', () => {
  it.each([1, 2, 3])('DELETE vs reset-onboarding, run %i', async () => {
    const u = await member();
    setBarrier();
    const rs = await Promise.all([call(userRoute, 'DELETE', { id: u }), call(resetOnboardingRoute, 'POST', { id: u })]);
    no5xx(rs);
    // A 200 has its one audit row, a 404 none; the user is gone either way.
    expect([rs[0]!.status, await audits(u, 'user.delete')]).toEqual([200, 1]);
    expect(await audits(u, 'user.reset_onboarding')).toBe(rs[1]!.status === 200 ? 1 : 0);
    expect(await n('SELECT count(*)::int n FROM users WHERE id = $1', [u])).toBe(0);
  }, 20000);

  it.each([1, 2, 3])('DELETE vs remove-from-company, run %i', async () => {
    const u = await member();
    setBarrier();
    const rs = await Promise.all([
      call(userRoute, 'DELETE', { id: u }),
      call(removeFromCompanyRoute, 'DELETE', { id: u }, { company_id: company }),
    ]);
    no5xx(rs);
    expect(rs[0]!.status).toBe(200);
    expect(await n('SELECT count(*)::int n FROM users WHERE id = $1', [u])).toBe(0);
  }, 20000);

  it.each([1, 2, 3])('DELETE vs an invitation accept of an existing member (replayed), run %i', async () => {
    const u = await member();
    setBarrier();
    const [del, accept] = await Promise.all([call(userRoute, 'DELETE', { id: u }), replayInviteAccept(u)]);
    expect(accept).not.toBe('40P01');
    expect(accept).toBe('ok');
    expect(del.status).toBeLessThan(500);
  }, 20000);
});

describe('E1 / E2: add-to-company and DELETE user', () => {
  it.each([1, 2, 3])('racing: no membership outlives the deleted user, run %i', async () => {
    const u = await member();
    setBarrier();
    // The add is held before its commit until the delete has answered: without the KEY SHARE the delete finishes
    // (its sweep cannot see the uncommitted membership) and the add then commits an orphan. With it, the delete's
    // DELETE FROM users waits for the add, so the hold times out, the add commits, and the sweep removes the row.
    const deleting = call(userRoute, 'DELETE', { id: u });
    probe.holdAdd = deleting.catch(() => undefined);
    const [del, add] = await Promise.all([
      deleting,
      call(addToCompanyRoute, 'POST', { id: u }, { company_id: company2, role: 'viewer' }),
    ]);
    no5xx([del, add]);
    expect(del.status).toBe(200);
    expect([200, 404]).toContain(add.status);
    expect(await n('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [u])).toBe(0);
  }, 20000);

  it('E2: a user that does not exist: 404, no membership, no audit row', async () => {
    const ghost = `${TAG}-ghost`;
    const r = await call(addToCompanyRoute, 'POST', { id: ghost }, { company_id: company2, role: 'viewer' });
    expect(r.status).toBe(404);
    expect(await n('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [ghost])).toBe(0);
    expect(await audits(ghost, 'user.add_to_company')).toBe(0);
    expect(await n('SELECT count(*)::int n FROM admin_audit_log WHERE target_id = $1', [ghost])).toBe(0);
  });

  it('a missing company is still its 404', async () => {
    const u = await member();
    const r = await call(addToCompanyRoute, 'POST', { id: u }, { company_id: crypto.randomUUID(), role: 'viewer' });
    expect(r.status).toBe(404);
  });
});
