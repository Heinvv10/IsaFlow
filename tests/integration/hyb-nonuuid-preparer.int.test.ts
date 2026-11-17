/**
 * Wave 6 HYb, adversarial review of #1564 (M + L), adopted from the reviewer's repro. Real routes (withAuth, app_user,
 * JWT claims) on the disposable fixture.
 *
 * After 999w prepared_by is TEXT, but approval_requests' actors and approval_document_authors are still uuid (wave 7).
 * Without a guard a non-UUID admin N could recalculate a run with a pending approval request, become its preparer, and
 * leave every approve, reject, withdraw and re-raise of that request failing with 22P02 (a 500 that also leaked N's
 * id). The ruling (option a): N is refused as the preparer of a run R-035 governs, with a typed 409 and nothing written.
 * Separately, a reject or a withdrawal never computes the document's authors (approvalAuthority#assertMayDecide), so a
 * request whose authors cannot be computed can still be closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import approvalRequests from '../../pages/api/accounting/approval-requests';

let r: Awaited<ReturnType<typeof rig>>;
const N = `sage-import-bot-hyb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  r = await rig('hyb-preparer');
  await r.setup();
  await r.employee(30000);
  await r.pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [N, `${N}@example.invalid`]);
  await r.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [r.company, N]);
  r.tokens[N] = await r.mint(N); // teardown deletes every user it holds a token for
}, 60000);
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.teardown();
}, 60000);

const ar = (user: string, body: unknown) => r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, { user, body });
const header = async (id: string) =>
  (await r.pool.query('SELECT prepared_by::text AS p, approval_revision::text AS v FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
const status = async (requestId: string) =>
  (await r.pool.query('SELECT status FROM approval_requests WHERE id = $1', [requestId])).rows[0]?.status;
async function raisedRun(month: number): Promise<{ id: string; req: { id: string; documentDigest: string } }> {
  const id = String((await r.api.createRun(month)).body.data!.id);
  expect((await r.api.calculate(id)).statusCode).toBe(200);
  const raised = await ar(r.admin, { action: 'request', documentType: 'pay_run', documentId: id });
  expect(raised.statusCode).toBe(200);
  return { id, req: raised.body.data as { id: string; documentDigest: string } };
}

describe('HYb: a non-UUID preparer and a pay run under R-035 approval', () => {
  it('N recalculating a run with a pending request is refused with 409 PREPARER_ID_NOT_SUPPORTED; nothing changes and the request is approved', async () => {
    const { id, req } = await raisedRun(6);
    const before = await header(id);

    const nCalc = await r.api.calculate(id, { user: N });
    expect(nCalc.statusCode).toBe(409);
    const body = JSON.stringify(nCalc.body);
    expect(body).toContain('PREPARER_ID_NOT_SUPPORTED');
    expect(body).toContain("This account can't prepare pay runs that need approval yet.");
    expect(body).not.toContain(N);
    expect(await header(id)).toEqual(before);
    expect(before.p).toBe(r.admin);

    const approved = await ar(r.approver, { action: 'approve', requestId: req.id, expectedDigest: req.documentDigest });
    expect(approved.statusCode).toBe(200);
    expect(await status(req.id)).toBe('approved');
  }, 180000);

  it('a request whose authors cannot be computed (a non-UUID preparer) can still be rejected by the approver and withdrawn by its requester', async () => {
    // Unreachable through the routes now (above); written directly, as a row from before the guard would be.
    const first = await raisedRun(7);
    await r.pool.query('UPDATE payroll_run_headers SET prepared_by = $1 WHERE id = $2', [N, first.id]);
    const rejected = await ar(r.approver, { action: 'reject', requestId: first.req.id });
    expect(rejected.statusCode, JSON.stringify(rejected.body)).toBe(200);
    expect(await status(first.req.id)).toBe('rejected');

    const second = await raisedRun(8);
    await r.pool.query('UPDATE payroll_run_headers SET prepared_by = $1 WHERE id = $2', [N, second.id]);
    const withdrawn = await ar(r.admin, { action: 'reject', requestId: second.req.id });
    expect(withdrawn.statusCode, JSON.stringify(withdrawn.body)).toBe(200);
    expect(await status(second.req.id)).toBe('rejected');
  }, 180000);
});
