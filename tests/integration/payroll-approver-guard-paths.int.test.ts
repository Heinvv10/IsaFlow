/**
 * The last-other-approver guard (payRunApproverGuard) on EVERY path that can take an approver away while a pay-run
 * approval is pending, through the real platform-admin routes (withAdmin / withPlatformAdmin on platform_admin):
 *   role change, link removal, suspension, user delete, onboarding reset  ->  409, nothing written.
 * (The company route and the member writes are in payroll-sole-approver.int.test.ts.)
 * Disposable schema fixture only (assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The fixture has no GoTrue to revoke sessions at: the suspension itself is what is under test.
vi.mock('@/lib/auth/gotrue', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/gotrue')>()),
  adminRevokeAllUserSessions: vi.fn(async () => undefined),
}));

import roleRoute from '../../pages/api/admin/users/[id]/company-role';
import removeRoute from '../../pages/api/admin/users/[id]/remove-from-company';
import suspendRoute from '../../pages/api/admin/users/[id]/suspend';
import userRoute from '../../pages/api/admin/users/[id]';
import resetRoute from '../../pages/api/admin/users/[id]/reset-onboarding';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertPayRunApproverRetainedEverywhere } from '@/modules/accounting/services/core/payRunApproverGuard';
import { rig, type Route } from './brkr.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';


const platformAdmin = crypto.randomUUID();
let r: Awaited<ReturnType<typeof rig>>;
let requestRow: { id: string; documentDigest: string };

beforeAll(async () => {
  r = await rig('approverguard'); // asserts the disposable fixture, on the unmodified URLs
  // The admin routes' pool logs in as platform_admin, as on production; it is created on first use, after this.
  const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
  asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
  process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();
  await r.setup();
  await r.employee(20000);
  await r.pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [platformAdmin, `${platformAdmin}@test.local`]);
  // `approver` (an owner in the rig) is parked as a viewer: only managers added below can approve, besides the requester.
  await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [r.company, r.approver]);
  const made = await r.api.createRun(5);
  const id = String(made.body.data!.id);
  await r.api.calculate(id);
  const raised = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
    { user: r.admin, body: { action: 'request', documentType: 'pay_run', documentId: id } });
  expect(raised.statusCode).toBe(200);
  requestRow = raised.body.data as { id: string; documentDigest: string };
}, 90000);
afterAll(async () => {
  await r.pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [platformAdmin]).catch(() => undefined);
  await r.pool.query('DELETE FROM user_sessions WHERE user_id = ANY($1)', [Object.keys(r.tokens)]).catch(() => undefined);
  await r.teardown();
  const { Pool } = await import('pg');
  const p = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await p.query('DELETE FROM users WHERE id = $1', [platformAdmin]).catch(() => undefined);
  await p.end();
});

async function call(route: Route, method: string, target: string, path: string, body: unknown) {
  const jar = { 'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, target) as unknown as { body: unknown; url: string };
  req.body = body;
  req.url = `/api/admin/users/${target}${path}`;
  const result = response();
  await route(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body as { error?: { message?: string } } };
}

/** A manager who is the ONLY member able to approve the pending request (the requester is the admin). */
async function soleManager(): Promise<string> {
  await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND role = 'manager'", [r.company]);
  const m = await r.addUser('manager');
  await r.pool.query("UPDATE users SET onboarding_completed = true WHERE id = $1", [m]);
  return m;
}
const roleOf = async (u: string) => (await r.pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [r.company, u])).rows[0]?.role ?? null;
const userRow = async (u: string) => (await r.pool.query('SELECT is_active, suspended_at FROM users WHERE id = $1', [u])).rows[0] ?? null;
const REFUSAL = /only other person who can approve a pay run/;

describe('platform-admin paths keep a pending pay-run approval decidable', () => {
  it('company-role: demoting the last other approver is a 409; with a second approver it is allowed', async () => {
    const m = await soleManager();
    const refused = await call(roleRoute as Route, 'PATCH', m, '/company-role', { company_id: r.company, role: 'viewer' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toMatch(REFUSAL);
    expect(await roleOf(m)).toBe('manager');

    const second = await r.addUser('manager');
    const allowed = await call(roleRoute as Route, 'PATCH', m, '/company-role', { company_id: r.company, role: 'viewer' });
    expect(allowed.status).toBe(200);
    expect(await roleOf(m)).toBe('viewer');
    await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [r.company, second]);
  }, 60000);

  it('remove-from-company: removing the last other approver is a 409', async () => {
    const m = await soleManager();
    const refused = await call(removeRoute as Route, 'DELETE', m, '/remove-from-company', { company_id: r.company });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toMatch(REFUSAL);
    expect(await roleOf(m)).toBe('manager');
  }, 60000);

  /** A fresh run with its own pending request, raised while `m` is the only other member who can approve. */
  async function pendingRequestWith(month: number): Promise<{ id: string; documentDigest: string }> {
    const made = await r.api.createRun(month);
    const id = String(made.body.data!.id);
    await r.api.calculate(id);
    const raised = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
      { user: r.admin, body: { action: 'request', documentType: 'pay_run', documentId: id } });
    expect(raised.statusCode).toBe(200);
    return raised.body.data as { id: string; documentDigest: string };
  }
  const selfApprove = (req: { id: string; documentDigest: string }) => r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests',
    undefined, { user: r.admin, body: { action: 'approve', requestId: req.id, expectedDigest: req.documentDigest } });
  const strandedAudit = async (action: string, user: string) => (await r.pool.query(
    `SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = $2 AND target_id = $3`,
    [platformAdmin, action, user])).rows.map((x) => x.details as { stranded_pay_run_requests?: Array<{ companyId: string; requestId: string }> });

  it('suspend is NEVER refused: the stranded request is audited and its requester still cannot self-approve it', async () => {
    const m = await soleManager();
    const req = await pendingRequestWith(6);
    // Control: while `m` can approve, the requester may not approve their own request.
    const before = await selfApprove(req);
    expect(before.statusCode).toBe(403);
    expect(before.body.error?.message).toMatch(/while another member can approve/);

    const suspended = await call(suspendRoute as Route, 'POST', m, '/suspend', { reason: 'compromised' });
    expect(suspended.status).toBe(200);
    expect(await userRow(m)).toMatchObject({ is_active: false });
    expect((await userRow(m))!.suspended_at).not.toBeNull();

    // The roster changed since the request was raised: the sole-approver fallback does not apply to it.
    const after = await selfApprove(req);
    expect(after.statusCode).toBe(403);
    expect(after.body.error?.message).toMatch(/members or roles changed since it was raised/);
    const stillPending = await r.pool.query("SELECT status FROM approval_requests WHERE id = $1", [req.id]);
    expect(stillPending.rows[0].status).toBe('pending');
    const audits = await strandedAudit('user.suspend', m);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.stranded_pay_run_requests?.map((x) => x.requestId)).toContain(req.id);
  }, 60000);

  it('delete user is NEVER refused: the user goes, the stranded request is audited and cannot be self-approved', async () => {
    const m = await soleManager();
    const req = await pendingRequestWith(7);
    const deleted = await call(userRoute as Route, 'DELETE', m, '', undefined);
    expect(deleted.status).toBe(200);
    expect(await userRow(m)).toBeNull();
    expect(await roleOf(m)).toBeNull();
    const after = await selfApprove(req);
    expect(after.statusCode).toBe(403);
    expect(after.body.error?.message).toMatch(/members or roles changed since it was raised/);
    const audits = await strandedAudit('user.delete', m);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.stranded_pay_run_requests?.map((x) => x.requestId)).toContain(req.id);
  }, 60000);

  it('reset-onboarding: resetting the last other approver is a 409 and the link stays', async () => {
    const m = await soleManager();
    const refused = await call(resetRoute as Route, 'POST', m, '/reset-onboarding', undefined);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toMatch(REFUSAL);
    expect(await roleOf(m)).toBe('manager');
    expect((await r.pool.query('SELECT onboarding_completed FROM users WHERE id = $1', [m])).rows[0].onboarding_completed).toBe(true);
  }, 60000);

  it('once the request is withdrawn nothing is refused any more (every-company guard included)', async () => {
    const m = await soleManager();
    await expect(assertPayRunApproverRetainedEverywhere(m)).rejects.toThrow(REFUSAL);
    const pending = (await r.pool.query(
      "SELECT id, document_digest FROM approval_requests WHERE company_id = $1 AND document_type = 'pay_run' AND status = 'pending'", [r.company])).rows;
    for (const p of pending) {
      const rejected = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
        { user: r.admin, body: { action: 'reject', requestId: p.id, expectedDigest: p.document_digest } });
      expect(rejected.statusCode).toBe(200);
    }
    await expect(assertPayRunApproverRetainedEverywhere(m)).resolves.toBeUndefined();
    const demoted = await call(roleRoute as Route, 'PATCH', m, '/company-role', { company_id: r.company, role: 'viewer' });
    expect(demoted.status).toBe(200);
  }, 60000);
});
