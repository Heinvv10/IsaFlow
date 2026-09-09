/**
 * K-043 adjacent cases for the approval decide path.
 *
 * The RED case (a requester approving their own request) lives in
 * k-043-self-approval-and-approver-role.int.test.ts. These cover the rest of
 * the segregation-of-duties surface: a non-requester below the rule's approver
 * role, the role that does satisfy the rule, the rejection path, and a decider
 * authenticated to a different company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, response } from './mfa-impersonation-postgres.helpers';
import type { NextApiRequest } from 'next';
import approvalRequests from '../../pages/api/accounting/approval-requests';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const requester = crypto.randomUUID();
const otherManager = crypto.randomUUID();
const owner = crypto.randomUUID();
const outsider = crypto.randomUUID();
const ruleId = crypto.randomUUID();
const approveRequest = crypto.randomUUID();
const rejectRequest = crypto.randomUUID();
const crossTenantRequest = crypto.randomUUID();
const ownerOwnRequest = crypto.randomUUID();
const adminDecider = crypto.randomUUID();
const ownerApproveRequest = crypto.randomUUID();
const foreignRuleId = crypto.randomUUID();
const foreignRuleRequest = crypto.randomUUID();
const raceRequest = crypto.randomUUID();
const tokens: Record<string, string> = {};

async function mint(userId: string) {
  return new SignJWT({ sub: userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

async function decide(userId: string, companyId: string, action: 'approve' | 'reject', requestId: string) {
  const csrf = 'disposable-postgres-workflow-csrf-0123456789';
  const cookies = { 'sb-access-token': tokens[userId]!, active_company_id: companyId, isaflow_csrf: csrf };
  const req = {
    method: 'POST', url: '/api/accounting/approval-requests', query: {}, cookies,
    headers: {
      cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
      'x-csrf-token': csrf,
    },
    body: { action, requestId, notes: `k043 ${action}` },
    socket: { remoteAddress: '127.0.0.85' },
  } as unknown as NextApiRequest;
  const result = response();
  await approvalRequests(req, result.res);
  return result;
}

async function readRequest(id: string) {
  const { rows } = await pool.query('SELECT status, decided_by FROM approval_requests WHERE id=$1', [id]);
  return rows[0];
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',
    [companyA, 'K043 company A', companyB, 'K043 company B']);
  // users.role is the platform-level role (no 'owner' in its CHECK); the
  // per-company role that the rule is matched against lives in company_users.
  for (const [id, role] of [[requester, 'manager'], [otherManager, 'manager'], [owner, 'admin'], [outsider, 'admin'], [adminDecider, 'admin']] as const) {
    await pool.query('INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)',
      [id, `k043-${id}@test.local`, role]);
    tokens[id] = await mint(id);
  }
  await pool.query(
    `INSERT INTO company_users(company_id,user_id,role)
     VALUES($1,$2,'manager'),($1,$3,'manager'),($1,$4,'owner'),($5,$6,'owner'),($1,$7,'admin')`,
    [companyA, requester, otherManager, owner, companyB, outsider, adminDecider]);
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active,priority)
     VALUES($1,$2,'K043 owner-only rule','supplier_invoice','total','greater_than',0,'owner',true,10)`,
    [ruleId, companyA]);
  // Owner-only, but owned by company B — invisible to company A's decide path.
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active,priority)
     VALUES($1,$2,'K043 company B owner-only rule','supplier_invoice','total','greater_than',0,'owner',true,10)`,
    [foreignRuleId, companyB]);
  for (const id of [approveRequest, rejectRequest, crossTenantRequest, ownerApproveRequest, raceRequest]) {
    await pool.query(
      `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,status,requested_by)
       VALUES($1,$2,$3,'supplier_invoice',$4,250000,'pending',$5)`,
      [id, companyA, ruleId, crypto.randomUUID(), requester]);
  }
  // Raised by the owner — the one person whose role does satisfy the rule.
  await pool.query(
    `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,status,requested_by)
     VALUES($1,$2,$3,'supplier_invoice',$4,250000,'pending',$5)`,
    [ownerOwnRequest, companyA, ruleId, crypto.randomUUID(), owner]);
  // Written directly: requestApproval now refuses a foreign rule id, but rows
  // predating that guard exist and still have to be decided safely.
  await pool.query(
    `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,status,requested_by)
     VALUES($1,$2,$3,'supplier_invoice',$4,250000,'pending',$5)`,
    [foreignRuleRequest, companyA, foreignRuleId, crypto.randomUUID(), requester]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM approval_requests WHERE company_id = ANY($1)', [[companyA, companyB]]);
    await pool.query('DELETE FROM approval_rules WHERE company_id = ANY($1)', [[companyA, companyB]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[companyA, companyB]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[requester, otherManager, owner, outsider, adminDecider]]);
  } finally { await pool.end(); }
});

describe('K-043 approval decision authority', () => {
  it('refuses a manager who is not the requester when the rule demands owner', async () => {
    const result = await decide(otherManager, companyA, 'approve', approveRequest);
    expect(result.state.statusCode).toBe(403);
    expect(result.state.body).toMatchObject({
      error: { details: { reason: 'APPROVER_ROLE_REQUIRED' } },
    });
    expect(await readRequest(approveRequest)).toMatchObject({ status: 'pending', decided_by: null });
  });

  it('refuses the requester even when their own role satisfies the rule', async () => {
    const result = await decide(owner, companyA, 'approve', ownerOwnRequest);
    expect(result.state.statusCode).toBe(403);
    expect(result.state.body).toMatchObject({
      error: { details: { reason: 'SELF_APPROVAL_FORBIDDEN' } },
    });
    expect(await readRequest(ownerOwnRequest)).toMatchObject({ status: 'pending', decided_by: null });
  });

  it('refuses a decider authenticated to another company', async () => {
    const result = await decide(outsider, companyB, 'approve', crossTenantRequest);
    expect(result.state.statusCode).not.toBe(200);
    expect(await readRequest(crossTenantRequest)).toMatchObject({ status: 'pending', decided_by: null });
  });

  it('lets the owner the rule demands approve someone else\'s request', async () => {
    const result = await decide(owner, companyA, 'approve', ownerApproveRequest);
    expect(result.state.statusCode).toBe(200);
    expect(await readRequest(ownerApproveRequest)).toMatchObject({ status: 'approved', decided_by: owner });
  });

  it('applies the same authority check to the rejection path', async () => {
    const refused = await decide(otherManager, companyA, 'reject', rejectRequest);
    expect(refused.state.statusCode).toBe(403);
    expect(await readRequest(rejectRequest)).toMatchObject({ status: 'pending', decided_by: null });

    const allowed = await decide(owner, companyA, 'reject', rejectRequest);
    expect(allowed.state.statusCode).toBe(200);
    expect(await readRequest(rejectRequest)).toMatchObject({ status: 'rejected', decided_by: owner });
  });
});

describe('K-043 review findings', () => {
  // M3: a request naming a rule this company cannot see must not fall back to
  // the 'admin' column default — that silently lowers an owner-only rule.
  it('refuses a decider when the request names a rule another company owns', async () => {
    const result = await decide(adminDecider, companyA, 'approve', foreignRuleRequest);
    expect(result.state.statusCode).toBe(403);
    expect(result.state.body).toMatchObject({
      error: { details: { reason: 'APPROVER_ROLE_REQUIRED' } },
    });
    expect(await readRequest(foreignRuleRequest)).toMatchObject({ status: 'pending', decided_by: null });
  });

  // M1: losing a decide race used to throw a bare Error and answer 500.
  it('answers 404, not 500, when the request was already decided', async () => {
    const first = await decide(owner, companyA, 'approve', raceRequest);
    expect(first.state.statusCode).toBe(200);

    const second = await decide(owner, companyA, 'approve', raceRequest);
    expect(second.state.statusCode).toBe(404);
    expect(await readRequest(raceRequest)).toMatchObject({ status: 'approved', decided_by: owner });
  });

  it('answers 404 for a request id that does not exist', async () => {
    const result = await decide(owner, companyA, 'approve', crypto.randomUUID());
    expect(result.state.statusCode).toBe(404);
  });

  // LOW-3: the id is cast ::UUID downstream, so a malformed one was a 22P02 —
  // a 500 with a logged stack, contradicting the contract fix.md states.
  it('answers 404, not 500, for a request id that is not a UUID', async () => {
    const result = await decide(owner, companyA, 'approve', 'not-a-uuid');
    expect(result.state.statusCode).toBe(404);
  });

  it('answers 400 for a document id that is not a UUID', async () => {
    // The rule id is no longer read from the body at all (round-4 HIGH-1); the
    // document id is what still reaches a `::UUID` cast.
    const csrf = 'disposable-postgres-workflow-csrf-0123456789';
    const cookies = { 'sb-access-token': tokens[owner]!, active_company_id: companyA, isaflow_csrf: csrf };
    const req = {
      method: 'POST', url: '/api/accounting/approval-requests', query: {}, cookies,
      headers: {
        cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
      },
      body: { action: 'request', documentType: 'payment', documentId: 'not-a-uuid' },
      socket: { remoteAddress: '127.0.0.85' },
    } as unknown as NextApiRequest;
    const result = response();
    await approvalRequests(req, result.res);
    expect(result.state.statusCode).toBe(400);
  });
});
