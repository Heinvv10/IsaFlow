/**
 * Admin audit 2026-11-14 item 3.3 (WP9): the console can never be left without an active super admin.
 *
 * PATCH /api/admin/users/[id] (a role change) and POST …/suspend take one roster lock and count the OTHER active
 * super admins before they touch a super admin; the last one is refused 409 LAST_SUPER_ADMIN. The lock is what
 * makes two concurrent demotions of the last two safe: without it each request sees the other still active and
 * both commit. Delete already refuses any super admin. A super admin acting on another super admin stays allowed
 * (no product decision forbids it) and its audit row says so.
 *
 * The race is forced, not hoped for, at two module boundaries:
 *   1. both requests are held in the admin rate-limit step (inside withPlatformAdmin's transaction, after its
 *      super-admin gate) until both have arrived, so each actor has passed the gate before either commits;
 *   2. each request is held again right after its count of the other super admins (the `sql` call, wrapped) until
 *      the other has counted too, or WINDOW_MS has passed. Without the roster lock both count before either
 *      writes, so both commit. With it the second waits on the lock before its count, the first is released by
 *      the time-out, commits, and the second then counts what the first left.
 * GoTrue is mocked at the module boundary (adminRevokeAllUserSessions); tokens are aal2, so the gate needs no
 * GoTrue. Runs as platform_admin on the disposable schema fixture (assertDisposable).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import userRoute from '../../pages/api/admin/users/[id]';
import suspendRoute from '../../pages/api/admin/users/[id]/suspend';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

const barrier = vi.hoisted(() => ({ parties: 0, arrived: 0, open: (): void => undefined, opened: Promise.resolve() }));
vi.mock('@/lib/rateLimit', async (orig) => {
  const actual = await orig<typeof import('@/lib/rateLimit')>();
  return {
    ...actual,
    checkRateLimit: async () => {
      if (barrier.parties > 0) {
        barrier.arrived += 1;
        if (barrier.arrived >= barrier.parties) barrier.open();
        await barrier.opened;
      }
      return true;
    },
  };
});
const counted = vi.hoisted(() => ({ parties: 0, arrived: 0, open: (): void => undefined, opened: Promise.resolve() }));
const WINDOW_MS = 750;
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = realSql(strings, ...values);
    if (counted.parties === 0 || !/role = 'super_admin' AND lower\(id\) <>/.test(strings.join('?'))) return query;
    return (async () => {
      const rows = await query;
      counted.arrived += 1;
      if (counted.arrived >= counted.parties) counted.open();
      await Promise.race([counted.opened, new Promise((resolve) => setTimeout(resolve, WINDOW_MS))]);
      return rows;
    })();
  }, realSql);
  return { ...real, sql };
});
vi.mock('@/lib/auth/gotrue', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/gotrue')>()),
  adminRevokeAllUserSessions: async () => undefined,
}));

function holdUntil(parties: number): void {
  for (const gate of [barrier, counted]) {
    gate.parties = parties;
    gate.arrived = 0;
    gate.opened = new Promise<void>((resolve) => { gate.open = resolve; });
  }
}

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const ACTORS = [A, B];
/** Super admins left by other suites are parked (is_active=false) for this file and restored after it. */
let parked: { id: string; is_active: boolean | null }[] = [];

type Route = (req: never, res: never) => Promise<unknown>;
async function call(route: Route, actor: string, method: string, target: string, path: string, body?: unknown) {
  const jar = { 'sb-access-token': await signSession(actor, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, target) as unknown as { body: unknown; url: string };
  req.body = body;
  req.url = `/api/admin/users/${target}${path}`;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { error?: { code?: string; message?: string; details?: { reason?: string } } } };
}
const demote = (actor: string, target: string) => call(userRoute as Route, actor, 'PATCH', target, '', { role: 'admin' });
const suspend = (actor: string, target: string) =>
  call(suspendRoute as Route, actor, 'POST', target, '/suspend', { reason: 'wp9 roster test' });
const remove = (actor: string, target: string) => call(userRoute as Route, actor, 'DELETE', target, '');

const activeSuperAdmins = async () => (await pool.query(
  `SELECT id FROM users WHERE id = ANY($1) AND role = 'super_admin' AND is_active AND suspended_at IS NULL
     AND (status IS NULL OR lower(status) = 'active') ORDER BY id`, [ACTORS])).rows.map((r) => r.id as string);
const audits = async (action: string) => (await pool.query(
  `SELECT admin_user_id, target_id, details FROM admin_audit_log
    WHERE admin_user_id = ANY($1) AND action = $2 ORDER BY created_at`, [ACTORS, action])).rows as
  { admin_user_id: string; target_id: string; details: Record<string, unknown> }[];

beforeAll(async () => {
  parked = (await pool.query(
    `UPDATE users u SET is_active = false FROM (SELECT id, is_active FROM users WHERE role = 'super_admin' FOR UPDATE) p
      WHERE u.id = p.id RETURNING u.id, p.is_active`)).rows;
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'super_admin', true)`,
    [A, `${A}@test.local`, B, `${B}@test.local`]);
}, 60000);

beforeEach(async () => {
  await pool.query(`UPDATE users SET role = 'super_admin', is_active = true, suspended_at = NULL, suspended_reason = NULL
    WHERE id = ANY($1)`, [ACTORS]);
  await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = ANY($1)', [ACTORS]);
});
afterEach(() => { barrier.parties = 0; counted.parties = 0; });

afterAll(async () => {
  try {
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = ANY($1)', [ACTORS]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [ACTORS]);
    for (const p of parked) await pool.query('UPDATE users SET is_active = $2 WHERE id = $1', [p.id, p.is_active]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
});

describe('3.3: the last active super admin', () => {
  it('two concurrent demotions of the last two super admins: one lands, the other is refused, one remains', async () => {
    holdUntil(2);
    const results = await Promise.all([demote(A, B), demote(B, A)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error?.details?.reason).toBe('LAST_SUPER_ADMIN');
    expect(await activeSuperAdmins()).toHaveLength(1);
    expect(await audits('user.update')).toHaveLength(1);
  });

  it('two concurrent suspensions of the last two super admins: one lands, the other is refused, one remains', async () => {
    holdUntil(2);
    const results = await Promise.all([suspend(A, B), suspend(B, A)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await activeSuperAdmins()).toHaveLength(1);
    expect(await audits('user.suspend')).toHaveLength(1);
  });

  it('a demotion racing a suspension of the other: still one remains', async () => {
    holdUntil(2);
    const results = await Promise.all([demote(A, B), suspend(B, A)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await activeSuperAdmins()).toHaveLength(1);
  });

  it('the only active super admin cannot demote, suspend or delete themselves; nothing is written', async () => {
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [B]);
    for (const attempt of [demote(A, A), suspend(A, A)]) {
      const r = await attempt;
      expect(r.status).toBe(409);
      expect(r.body.error?.details?.reason).toBe('LAST_SUPER_ADMIN');
    }
    expect((await remove(A, A)).status).toBeGreaterThanOrEqual(400);
    expect(await activeSuperAdmins()).toEqual([A]);
    expect(await audits('user.update')).toEqual([]);
    expect(await audits('user.suspend')).toEqual([]);
  });

  it('a suspended super admin does not count: the last active one is still protected', async () => {
    await pool.query(`UPDATE users SET is_active = false, suspended_at = now() WHERE id = $1`, [B]);
    expect((await demote(A, A)).status).toBe(409);
    expect(await activeSuperAdmins()).toEqual([A]);
  });

  it('a super admin may demote another while one remains, and the audit row says it was a super admin', async () => {
    const r = await demote(A, B);
    expect(r.status).toBe(200);
    expect(await activeSuperAdmins()).toEqual([A]);
    const [row] = await audits('user.update');
    expect(row).toMatchObject({ admin_user_id: A, target_id: B });
    expect(row!.details).toMatchObject({ target_super_admin: true, previous_role: 'super_admin', role: 'admin' });
  });

  it('a super admin may suspend another while one remains, and the audit row says it was a super admin', async () => {
    expect((await suspend(A, B)).status).toBe(200);
    expect(await activeSuperAdmins()).toEqual([A]);
    const [row] = await audits('user.suspend');
    expect(row!.details).toMatchObject({ target_super_admin: true });
  });

  it('Codex: the last super admin edited with its role sent unchanged (the form sends it) is a 200, not a refusal', async () => {
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [B]);
    const r = await call(userRoute as Route, A, 'PATCH', A, '', { role: 'super_admin', first_name: 'Renamed' });
    expect(r.status).toBe(200);
    const [row] = (await pool.query('SELECT role, first_name FROM users WHERE id = $1', [A])).rows;
    expect(row).toEqual({ role: 'super_admin', first_name: 'Renamed' });
    const [audit] = await audits('user.update');
    expect(audit!.details).not.toHaveProperty('previous_role'); // no role change recorded
    // A real demotion of the same last super admin is still refused.
    expect((await demote(A, A)).status).toBe(409);
  });

  it('role super_admin is never a promotion: 400 for a user who is not one, nothing written', async () => {
    const r = await call(userRoute as Route, A, 'PATCH', B, '', { role: 'admin' });
    expect(r.status).toBe(200); // B demoted while A remains
    const promote = await call(userRoute as Route, A, 'PATCH', B, '', { role: 'super_admin', first_name: 'Nope' });
    expect(promote.status).toBe(400);
    const [row] = (await pool.query('SELECT role, first_name FROM users WHERE id = $1', [B])).rows;
    expect(row.role).toBe('admin');
    expect(row.first_name).not.toBe('Nope');
  });

  it('suspending a user who does not exist is a 404 and writes nothing', async () => {
    const ghost = crypto.randomUUID();
    const r = await suspend(A, ghost);
    expect(r.status).toBe(404);
    expect(await audits('user.suspend')).toEqual([]);
  });
});
