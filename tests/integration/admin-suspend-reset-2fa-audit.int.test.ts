/**
 * Admin audit 2026-11-14 items 3.2 and 3.3 (WP9), through the real admin routes on the disposable fixture.
 *
 * 3.2 Suspend is atomic with its audit row. The suspension (the durable gate every auth path reads) commits WITH a
 * `user.suspend` row or not at all:
 *   - GoTrue cannot revoke the browser sessions: the suspension still commits (a compromised account must be closed
 *     even while GoTrue is down), the audit row records `revocation_failed: true`, and the admin is told exactly
 *     that (200, `sessions_revoked: false`, a message naming Force Logout).
 *   - anything else fails after the flag was written: a 5xx, so withPlatformAdmin rolls the suspension back and
 *     records an admin_request_failed row. It used to answer 400, which COMMITs: suspended, no audit row, and the
 *     admin told "Failed to suspend user".
 * 3.3 reset-2fa commits a `user.reset_2fa_started` row on its own connection BEFORE GoTrue is touched (a failed
 * write removes no factor; a later failure cannot erase it), then records the outcome in `user.reset_2fa`. A factor
 * not confirmed removed is never a 200: a refusal is `incomplete`, a timeout or outage is `unknown` (GoTrue may
 * have removed it), both 424.
 *
 * GoTrue is mocked at the module boundary (gotrue.adminRevokeAllUserSessions, gotrue-mfa); PATs are the injected
 * non-GoTrue failure. Tokens are aal2. Runs as platform_admin.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import suspendRoute from '../../pages/api/admin/users/[id]/suspend';
import reset2faRoute from '../../pages/api/admin/users/[id]/reset-2fa';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

const gotrue = vi.hoisted(() => ({
  revokeFails: false,
  patsFail: false,
  factors: [] as { id: string }[],
  /** GoTrue answers 422: a definite refusal, the factor stays. */
  refuseFactor: null as string | null,
  /** GoTrue deletes the factor, then the answer is lost (the 5 s bound): the outcome is unknown to the route. */
  timeoutFactor: null as string | null,
  unenrolled: [] as string[],
}));
vi.mock('@/lib/auth/gotrue', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/gotrue')>()),
  adminRevokeAllUserSessions: async () => { if (gotrue.revokeFails) throw new Error('wp9: GoTrue unreachable'); },
}));
vi.mock('@/lib/auth/personalAccessTokens', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/personalAccessTokens')>();
  return {
    ...actual,
    revokeAllUserPats: async (userId: string) => {
      if (gotrue.patsFail) throw new Error('wp9: PAT revocation crashed');
      return actual.revokeAllUserPats(userId);
    },
  };
});
vi.mock('@/lib/auth/gotrue-mfa', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/gotrue-mfa')>();
  const { AuthUpstreamUnavailableError } = await import('@/lib/auth/authUpstream');
  return {
    ...actual,
    adminListUserFactors: async () => gotrue.factors.map((f) => ({ ...f, factor_type: 'totp', status: 'verified' })),
    adminUnenrollFactor: async (_userId: string, factorId: string) => {
      if (factorId === gotrue.refuseFactor) throw new actual.GotrueMfaError(422, 'wp9: unenrol refused', null);
      gotrue.unenrolled.push(factorId);
      if (factorId === gotrue.timeoutFactor) {
        throw new AuthUpstreamUnavailableError('gotrue DELETE factor unavailable: TimeoutError: The operation was aborted due to timeout');
      }
    },
  };
});

assertDisposable();
const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const admin = crypto.randomUUID();
const target = crypto.randomUUID();

type Route = (req: never, res: never) => Promise<unknown>;
type Body = { success?: boolean; message?: string; data?: Record<string, unknown>; error?: { code?: string; message?: string } };
async function call(route: Route, path: string, body?: unknown) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, 'POST', target) as unknown as { body: unknown; url: string };
  req.body = body;
  req.url = `/api/admin/users/${target}${path}`;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as Body };
}
const suspend = () => call(suspendRoute as Route, '/suspend', { reason: 'wp9 suspend test' });
const reset2fa = () => call(reset2faRoute as Route, '/reset-2fa');
const isActive = async () => (await pool.query('SELECT is_active FROM users WHERE id = $1', [target])).rows[0].is_active;
const audits = async (action: string) => (await pool.query(
  `SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND target_id = $2 AND action = $3 ORDER BY created_at`,
  [admin, target, action])).rows.map((r) => r.details as Record<string, unknown>);

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true), ($3, $4, 'viewer', true)`,
    [admin, `${admin}@test.local`, target, `${target}@test.local`]);
}, 60000);

beforeEach(async () => {
  Object.assign(gotrue, { revokeFails: false, patsFail: false, factors: [], refuseFactor: null, timeoutFactor: null, unenrolled: [] });
  await pool.query(`UPDATE users SET role = 'viewer', is_active = true, suspended_at = NULL, suspended_reason = NULL WHERE id = $1`, [target]);
  await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
});

afterAll(async () => {
  try {
    await pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp9_block_reset_2fa_audit`);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[admin, target]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
});

describe('3.2: suspend is atomic with its audit row', () => {
  it('GoTrue revocation fails: suspended, audited as revocation_failed, and the admin is told exactly that', async () => {
    gotrue.revokeFails = true;
    const r = await suspend();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ suspended: true, sessions_revoked: false });
    expect(r.body.message).toMatch(/browser sessions could not be revoked/i);
    expect(r.body.message).toMatch(/Force Logout/);
    expect(await isActive()).toBe(false);
    expect(await audits('user.suspend')).toEqual([expect.objectContaining({ revocation_failed: true })]);
  });

  it('a non-GoTrue failure after the flag rolls the suspension back and records the failed attempt', async () => {
    gotrue.patsFail = true;
    const r = await suspend();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await isActive()).toBe(true);
    expect(await audits('user.suspend')).toEqual([]);
    expect(await audits('admin_request_failed')).toHaveLength(1);
  });

  it('a clean suspension: 200, sessions revoked, audited as not failed', async () => {
    const r = await suspend();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ suspended: true, sessions_revoked: true });
    expect(await isActive()).toBe(false);
    expect(await audits('user.suspend')).toEqual([expect.objectContaining({ revocation_failed: false })]);
  });
});

const block = (action: string) => pool.query(`ALTER TABLE admin_audit_log ADD CONSTRAINT wp9_block_reset_2fa_audit
  CHECK (action <> '${action}' OR admin_user_id <> '${admin}') NOT VALID`);
const unblock = () => pool.query(`ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS wp9_block_reset_2fa_audit`);

describe('3.3: reset-2fa is audited and reports failure honestly', () => {
  afterEach(async () => { await unblock(); });

  it('every factor removed: 200, a committed started row, and a complete outcome row', async () => {
    gotrue.factors = [{ id: 'f1' }, { id: 'f2' }];
    const r = await reset2fa();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ factors_removed: 2 });
    expect(gotrue.unenrolled).toEqual(['f1', 'f2']);
    expect(await audits('user.reset_2fa_started')).toEqual([expect.objectContaining({ factor_ids: ['f1', 'f2'] })]);
    expect(await audits('user.reset_2fa')).toEqual([
      expect.objectContaining({ outcome: 'complete', removed_factor_ids: ['f1', 'f2'] }),
    ]);
  });

  it('GoTrue refuses one factor: 424 naming it, never 200, and the outcome row says incomplete', async () => {
    gotrue.factors = [{ id: 'f1' }, { id: 'f2' }];
    gotrue.refuseFactor = 'f2';
    const r = await reset2fa();
    expect(r.status).toBe(424);
    expect(r.body.success).toBe(false);
    expect(r.body.error?.message).toMatch(/1 of 2/);
    expect(gotrue.unenrolled).toEqual(['f1']);
    expect(await audits('user.reset_2fa')).toEqual([
      expect.objectContaining({ outcome: 'incomplete', factors_removed: 1, failed_factor_ids: ['f2'] }),
    ]);
  });

  it('R1 GoTrue removed the factor but the answer timed out: 424, recorded as unknown, never "not removed"', async () => {
    gotrue.factors = [{ id: 'f1' }, { id: 'f2' }];
    gotrue.timeoutFactor = 'f1';
    const r = await reset2fa();
    expect(r.status).toBe(424);
    expect(r.body.error?.message).toMatch(/may or may not have been removed/);
    expect(gotrue.unenrolled).toEqual(['f1']); // GoTrue did remove it; the loop stops at the outage
    expect(await audits('user.reset_2fa_started')).toEqual([expect.objectContaining({ factor_ids: ['f1', 'f2'] })]);
    expect(await audits('user.reset_2fa')).toEqual([expect.objectContaining({
      outcome: 'unknown', unknown_factor_ids: ['f1'], not_attempted_factor_ids: ['f2'], failed_factor_ids: [],
    })]);
  });

  it('R2 the outcome row cannot be written after a factor went: the committed started row still records it', async () => {
    gotrue.factors = [{ id: 'f1' }, { id: 'f2' }];
    gotrue.refuseFactor = 'f2';
    await block('user.reset_2fa');
    const r = await reset2fa();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(gotrue.unenrolled).toEqual(['f1']);
    expect(await audits('user.reset_2fa_started')).toEqual([expect.objectContaining({ factor_ids: ['f1', 'f2'] })]);
    expect(await audits('admin_request_failed')).toHaveLength(1);
  });

  it('the started row cannot be written: no factor is removed, and the answer is a failure', async () => {
    gotrue.factors = [{ id: 'f1' }];
    await block('user.reset_2fa_started');
    const r = await reset2fa();
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(gotrue.unenrolled).toEqual([]);
  });

  it('a super admin target: allowed, and the audit rows say it was a super admin', async () => {
    await pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [target]);
    gotrue.factors = [{ id: 'f1' }];
    expect((await reset2fa()).status).toBe(200);
    expect(await audits('user.reset_2fa_started')).toEqual([expect.objectContaining({ target_super_admin: true })]);
    expect(await audits('user.reset_2fa')).toEqual([expect.objectContaining({ target_super_admin: true })]);
  });
});
