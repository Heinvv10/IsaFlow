/**
 * Who the last-approver guard counts as "another approver" is exactly who approval_request_decide would let approve:
 *  - the demand RATCHETS: the higher of the role the request was raised under (`required_role`) and its bound rule's
 *    role today; a member below it does not count (each operand proved on its own);
 *  - an author of the content (the run's `prepared_by`, the request's `content_authors`) never approves it (RA001),
 *    so a manager who prepared the run does not make the other manager's demotion safe.
 * Through the real company-users route on a throwaway cluster. Disposable schema fixture only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import companyUsers from '../../pages/api/accounting/company-users';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { rig, type Route } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let month = 0;
beforeAll(async () => {
  r = await rig('approverelig');
  await r.setup();
  await r.employee(20000);
  await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2", [r.company, r.approver]);
}, 90000);
afterAll(async () => { await r.teardown(); });

const put = (user: string, role: string) => r.call(companyUsers as Route, 'PUT', '/api/accounting/company-users', undefined, { body: { userId: user, role } });
const roleOf = async (u: string) => (await r.pool.query('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [r.company, u])).rows[0]?.role as string;
const REFUSAL = /only other person who can approve a pay run/;

/** Members other than the admin requester become viewers, nothing pending, then a fresh pending request by the admin. */
async function freshRequest(): Promise<{ id: string; run: string }> {
  await r.pool.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id <> $2", [r.company, r.admin]);
  await r.pool.query("UPDATE approval_requests SET status = 'rejected' WHERE company_id = $1 AND status = 'pending'", [r.company]);
  month += 1;
  const made = await r.api.createRun(month);
  const run = String(made.body.data!.id);
  await r.api.calculate(run);
  return { id: '', run };
}
async function raise(run: string): Promise<string> {
  const raised = await r.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
    { user: r.admin, body: { action: 'request', documentType: 'pay_run', documentId: run } });
  expect(raised.statusCode).toBe(200);
  return String((raised.body.data as { id: string }).id);
}

describe('authors do not count as approvers', () => {
  it("the run's preparer is not another approver: demoting the other manager is refused; the preparer's own demotion is not", async () => {
    const { run } = await freshRequest();
    const preparer = await r.addUser('manager');
    const other = await r.addUser('manager');
    await r.pool.query('UPDATE payroll_run_headers SET prepared_by = $2 WHERE id = $1', [run, preparer]);
    await raise(run);
    const refused = await put(other, 'viewer');
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error?.message ?? refused.body.message).toMatch(REFUSAL);
    expect(await roleOf(other)).toBe('manager');
    // The preparer cannot approve it anyway, so their demotion strands nothing.
    expect((await put(preparer, 'viewer')).statusCode).toBe(200);
  }, 60000);

  it("a content author on the request's snapshot is not another approver either", async () => {
    const { run } = await freshRequest();
    const author = await r.addUser('manager');
    const other = await r.addUser('manager');
    const request = await raise(run);
    await r.pool.query('UPDATE approval_requests SET content_authors = ARRAY[$2::uuid] WHERE id = $1', [request, author]);
    expect((await put(other, 'viewer')).statusCode).toBe(409);
    expect((await put(author, 'viewer')).statusCode).toBe(200);
  }, 60000);
});

describe('the demand ratchets: a member below it does not count (each operand)', () => {
  /** An admin who may approve a request demanding admin, a manager who may not, and the admin requester. */
  async function adminAndManager(run: string): Promise<{ admin2: string; manager: string }> {
    const admin2 = await r.addUser('admin');
    const manager = await r.addUser('manager');
    await raise(run);
    return { admin2, manager };
  }

  it('required_role: raised under admin, the rule since lowered to manager: the manager does not count', async () => {
    const { run } = await freshRequest();
    const { admin2, manager } = await adminAndManager(run);
    // The rule says manager (4); the request was raised under admin (5): the higher one governs.
    await r.pool.query("UPDATE approval_requests SET required_role = 'admin' WHERE company_id = $1 AND status = 'pending'", [r.company]);
    const refused = await put(admin2, 'viewer');
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error?.message ?? refused.body.message).toMatch(REFUSAL);
    expect(await roleOf(admin2)).toBe('admin');
    expect(await roleOf(manager)).toBe('manager');
  }, 60000);

  it("the bound rule's role today: raised under manager, the rule since raised to admin: the manager does not count", async () => {
    const { run } = await freshRequest();
    const { admin2 } = await adminAndManager(run);
    // The pay-run rule is fixed in production (trigger RA035); the fixture lifts that to raise it, then puts it back.
    await r.pool.query('ALTER TABLE approval_rules DISABLE TRIGGER trg_pay_run_rule_immutable');
    try {
      await r.pool.query("UPDATE approval_rules SET approver_role = 'admin' WHERE company_id = $1 AND document_type = 'pay_run'", [r.company]);
      const refused = await put(admin2, 'viewer');
      expect(refused.statusCode).toBe(409);
    } finally {
      await r.pool.query("UPDATE approval_rules SET approver_role = 'manager' WHERE company_id = $1 AND document_type = 'pay_run'", [r.company]);
      await r.pool.query('ALTER TABLE approval_rules ENABLE TRIGGER trg_pay_run_rule_immutable');
    }
  }, 60000);

  it('control: at the demanded rank a second admin does count, so the demotion is allowed', async () => {
    const { run } = await freshRequest();
    const { admin2 } = await adminAndManager(run);
    await r.addUser('admin'); // a third admin, also eligible
    await r.pool.query("UPDATE approval_requests SET required_role = 'admin' WHERE company_id = $1 AND status = 'pending'", [r.company]);
    expect((await put(admin2, 'viewer')).statusCode).toBe(200);
  }, 60000);
});

describe('by person, not by row', () => {
  it('a case-variant company_users row of the target is not another approver', async () => {
    const { run } = await freshRequest();
    const m = await r.addUser('manager');
    await raise(run);
    // The same person under an upper-case id: the writes match lower(user_id) and hit both rows. users.id is text, so a
    // profile under that id makes the variant row look like a member in good standing (the case that fails open).
    await r.pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [m.toUpperCase(), `${m}-variant@test.local`]);
    await r.pool.query('ALTER TABLE company_users DISABLE TRIGGER USER');
    try {
      await r.pool.query('INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)', [r.company, m.toUpperCase(), 'manager']);
    } finally { await r.pool.query('ALTER TABLE company_users ENABLE TRIGGER USER'); }
    const refused = await put(m, 'viewer');
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error?.message ?? refused.body.message).toMatch(REFUSAL);
    await r.pool.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [r.company, m.toUpperCase()]);
    await r.pool.query('DELETE FROM users WHERE id = $1', [m.toUpperCase()]);
  }, 60000);
});
