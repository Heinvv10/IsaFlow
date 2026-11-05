/**
 * R-035 pay-run approval, the sole-approver fallback (decision Q2) and who approved:
 *  - the header's approved_by is the person who DECIDED the approval, not the one who pressed approve;
 *  - a run approved by its own requester (nobody else could) says so: in the pay run's audit trail, on the
 *    run API (`selfApprovedSoleApprover`) and in the approval request's own audit row;
 *  - while a pay-run approval is pending, the last other eligible approver cannot be demoted or removed (409).
 * Real routes (withAuth, app_user, RLS, migration_admin member writes) against the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import runDetail from '../../pages/api/payroll/runs/[id]';
import companyUsers from '../../pages/api/accounting/company-users';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
beforeAll(async () => { r = await rig('soleapprover'); await r.setup(); await r.employee(20000); }, 60000);
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.teardown();
});

const setRole = (user: string, role: string) =>
  r.pool.query('UPDATE company_users SET role = $3 WHERE company_id = $1 AND user_id = $2', [r.company, user, role]);
const roleOf = async (user: string) =>
  (await r.pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [r.company, user])).rows[0]?.role ?? null;

async function newRun(month: number): Promise<string> {
  const made = await r.api.createRun(month);
  expect(made.statusCode).toBe(201);
  const id = String(made.body.data!.id);
  expect((await r.api.calculate(id)).statusCode).toBe(200);
  return id;
}
const raise = (id: string, user: string) => r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
  { user, body: { action: 'request', documentType: 'pay_run', documentId: id } });
const decide = (action: 'approve' | 'reject', request: { id: string; documentDigest: string }, user: string) =>
  r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
    { user, body: { action, requestId: request.id, expectedDigest: request.documentDigest } });
const execute = (id: string, planHash: unknown) =>
  r.call(approve as Route, 'POST', `/api/payroll/runs/${id}/approve`, id, { body: { expectedPlanHash: planHash } });
const detail = (id: string) => r.call(runDetail as Route, 'GET', `/api/payroll/runs/${id}`, id);
const trail = async (id: string) => (await r.pool.query(
  `SELECT changes->'metadata'->>'event' AS event, changes->'metadata'->>'selfApproval' AS self, user_id::text AS actor,
          changes->'metadata'->>'decidedBy' AS decided_by
     FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_run' AND entity_id = $2 ORDER BY created_at`,
  [r.company, id])).rows as Array<{ event: string; self: string | null; actor: string; decided_by: string | null }>;
const header = async (id: string) => (await r.pool.query(
  'SELECT approved_by::text AS approved_by, prepared_by::text AS prepared_by, status FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;

describe('who approved: the decider is on the header, the executor in the trail', () => {
  it('approved_by is the approver who decided; the executor (who pressed approve) is the audit actor', async () => {
    await setRole(r.approver, 'owner');
    const id = await newRun(1);
    const planHash = (await r.api.preview(id)).body.data?.planHash;
    const request = (await raise(id, r.admin)).body.data as { id: string; documentDigest: string };
    expect((await decide('approve', request, r.approver)).statusCode).toBe(200);
    expect((await execute(id, planHash)).statusCode).toBe(200);

    const h = await header(id);
    expect(h.status).toBe('approved');
    expect(h.approved_by).toBe(r.approver);
    expect(h.prepared_by).toBe(r.admin);
    const executed = (await trail(id)).find((e) => e.event === 'executed')!;
    expect(executed.actor).toBe(r.admin);
    expect(executed.decided_by).toBe(r.approver);
    expect(executed.self).toBeNull();
    const run = (await detail(id)).body.data!;
    expect(run.selfApprovedSoleApprover).toBe(false);
    expect(run.approvalDecision).toMatchObject({ decidedBy: r.approver, selfApprovedSoleApprover: false, preparedByDecider: false });
  }, 60000);
});

describe('the sole-approver fallback is kept and recorded', () => {
  it('a requester nobody else could replace approves their own run: flagged in the trail, on the run, on the request', async () => {
    await setRole(r.approver, 'viewer'); // admin is now the only member who can approve a pay run
    const id = await newRun(2);
    const planHash = (await r.api.preview(id)).body.data?.planHash;
    const request = (await raise(id, r.admin)).body.data as { id: string; documentDigest: string };
    expect((await decide('approve', request, r.admin)).statusCode).toBe(200);
    expect((await execute(id, planHash)).statusCode).toBe(200);

    const h = await header(id);
    expect(h.approved_by).toBe(r.admin);
    expect(h.prepared_by).toBe(r.admin);
    const events = await trail(id);
    expect(events.find((e) => e.event === 'authorised')).toMatchObject({ self: 'sole_approver', actor: r.admin });
    expect(events.find((e) => e.event === 'executed')).toMatchObject({ self: 'sole_approver', decided_by: r.admin });
    const run = (await detail(id)).body.data!;
    expect(run.selfApprovedSoleApprover).toBe(true);
    expect(run.approvalDecision).toMatchObject({ decidedBy: r.admin, requestedBy: r.admin, preparedBy: r.admin, preparedByDecider: true });
    const requestAudit = await r.pool.query(
      `SELECT 1 FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_request' AND entity_id = $2
          AND changes->'metadata'->>'selfApproval' = 'sole_approver'`, [r.company, request.id]);
    expect(requestAudit.rowCount).toBe(1);
  }, 60000);

  it('it is still refused while another member can approve', async () => {
    await setRole(r.approver, 'owner');
    const id = await newRun(3);
    const request = (await raise(id, r.admin)).body.data as { id: string; documentDigest: string };
    const refused = await decide('approve', request, r.admin);
    expect(refused.statusCode).toBe(403);
    await decide('reject', request, r.admin);
  }, 60000);
});

describe('the last other eligible approver of a pending pay-run approval cannot be demoted or removed', () => {
  const put = (user: string, role: string) => r.call(companyUsers as Route, 'PUT', '/api/accounting/company-users', undefined, { body: { userId: user, role } });
  const del = (user: string) => r.call(companyUsers as Route, 'DELETE', '/api/accounting/company-users', undefined, { body: { userId: user } });

  it('409 while the request is pending, with a reason; fine once a second approver exists or the request is decided', async () => {
    await setRole(r.approver, 'viewer');
    const manager = await r.addUser('manager');
    const manager2 = await r.addUser('manager');
    await setRole(manager2, 'viewer'); // parked: only `manager` can approve for now
    const id = await newRun(4);

    // No request pending: the demotion is the company's own business.
    expect((await put(manager2, 'viewer')).statusCode).toBe(200);

    const request = (await raise(id, r.admin)).body.data as { id: string; documentDigest: string };
    const demote = await put(manager, 'viewer');
    expect(demote.statusCode).toBe(409);
    expect(demote.body.error?.message ?? demote.body.message).toMatch(/only other person who can approve a pay run/);
    expect((await del(manager)).statusCode).toBe(409);
    expect(await roleOf(manager)).toBe('manager');

    // Someone else able to approve: no longer the last one.
    await setRole(manager2, 'manager');
    expect((await put(manager, 'viewer')).statusCode).toBe(200);
    // ...but manager2 now is: a change that keeps them able to approve is fine, one that does not is refused.
    expect((await put(manager2, 'admin')).statusCode).toBe(200);
    expect((await put(manager2, 'viewer')).statusCode).toBe(409);
    expect((await del(manager2)).statusCode).toBe(409);

    // The request withdrawn (the requester rejects their own): nothing pending, the change is allowed.
    expect((await decide('reject', request, r.admin)).statusCode).toBe(200);
    expect((await put(manager2, 'viewer')).statusCode).toBe(200);
    expect((await del(manager2)).statusCode).toBe(200);
  }, 90000);
});
