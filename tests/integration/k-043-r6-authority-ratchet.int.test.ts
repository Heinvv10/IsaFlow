/**
 * K-043 round-6 review, HIGH-1 and its class.
 *
 * The authority a PENDING request demands was recomputed at decide time from two
 * inputs, and an actor at or below that authority could lower either one:
 *
 *   A. `approval_requests.rule_id` — `rebindPendingRequest` moved a pending row
 *      onto whatever rule today's facts chose, in EITHER direction. An admin
 *      whose request was bound to the admin rule raised that rule's
 *      `condition_value` out of range, re-requested, and the row rebound to the
 *      `manager any` rule sitting beside it. (The reviewer's repro.)
 *   B. `approval_rules.approver_role` — `assertMayDecide` reads it LIVE, and rule
 *      authority deliberately lets an actor edit any rule at or below their own
 *      rank. So the same admin could simply hand the BOUND rule down to
 *      'manager' and skip the rebind entirely. Nothing in round 6 named this
 *      lever; it is the same escalation with one fewer step.
 *   B'. `is_active` — deactivating the bound rule takes it out of the candidate
 *      set, which is lever A by a different field.
 *
 * The closure is a ratchet, not a patch on any one lever: the demanded role is
 * SNAPSHOT onto the request when it is raised (`required_role`, migration 669),
 * a rebind may only raise it, and the decide path demands the HIGHER of the
 * snapshot and the bound rule's live role. New facts may make a pending request
 * stricter; nothing may make it laxer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { deletePlantedDocuments, plantDocument } from './approval-document.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const admin = crypto.randomUUID();
const manager = crypto.randomUUID();
const owner = crypto.randomUUID();
const users = [admin, manager, owner];
const tokens: Record<string, string> = {};

const sign = (id: string) => new SignJWT({ sub: id, aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

beforeAll(async () => {
  for (const id of users) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)",
      [id, `${id}@test.local`]);
    tokens[id] = await sign(id);
  }
});

/** Own company per case: rules match by document type across the whole company. */
async function newCompany(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `K043r6 ${id.slice(0, 8)}`]);
  for (const [userId, role] of [[admin, 'admin'], [manager, 'manager'], [owner, 'owner']] as const) {
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [id, userId, role]);
  }
  companies.push(id);
  return id;
}

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=ANY($1)', [companies]);
    await deletePlantedDocuments(pool, companies);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1)', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1)', [companies]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
});

function call(handler: typeof approvalRules, as: string, companyId: string, method: string, body: unknown, query: Record<string, string> = {}) {
  const req = request({ 'sb-access-token': tokens[as]!, active_company_id: companyId }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = query;
  req.url = '/api/accounting/approval-requests';
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

const reasonOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

async function plantRule(companyId: string, name: string, documentType: string, approverRole: string,
  operator = 'any', value = 0): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES($1,$2,$3,$4,'amount',$5,$6,$7,true)`, [id, companyId, name, documentType, operator, value, approverRole]);
  return id;
}

const storedRequest = async (documentId: string) => (await pool.query(
  'SELECT id, rule_id, amount, required_role, status FROM approval_requests WHERE document_id=$1',
  [documentId])).rows[0];

/** The admin rule / manager rule pair the reviewer used, plus the R500 000 bill. */
async function raisedUnderTheAdminRule() {
  const company = await newCompany();
  const adminRule = await plantRule(company, 'r6 admin over 100k', 'supplier_invoice', 'admin', 'greater_than', 100000);
  const managerRule = await plantRule(company, 'r6 manager any', 'supplier_invoice', 'manager');
  const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);

  const raised = await call(approvalRequests, admin, company, 'POST', {
    action: 'request', documentType: 'supplier_invoice', documentId,
  });
  expect(raised.state.statusCode).toBe(200);
  const stored = await storedRequest(documentId);
  expect(stored.rule_id).toBe(adminRule);
  return { company, adminRule, managerRule, documentId, requestId: stored.id as string };
}

describe('HIGH-1 lever A — the rebind may not move a request onto a laxer rule', () => {
  it('refuses the manager after the bound rule is raised out of range and the request re-POSTed', async () => {
    const { company, adminRule, managerRule, documentId, requestId } = await raisedUnderTheAdminRule();

    // The lever: the admin edits a rule AT THEIR OWN RANK, which rule authority
    // permits, so that the admin rule no longer matches a R500 000 invoice.
    const edited = await call(approvalRules, admin, company, 'PUT', { id: adminRule, conditionValue: 10000000 });
    expect(edited.state.statusCode).toBe(200);

    const reRaised = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    expect(reRaised.state.statusCode).toBe(200);

    // The pending row must not have been handed to the manager rule.
    const after = await storedRequest(documentId);
    expect(after.rule_id).toBe(adminRule);
    expect(after.rule_id).not.toBe(managerRule);
    expect(Number(after.amount)).toBe(500000);

    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
    expect(reasonOf(bypass)).toBe('APPROVER_ROLE_REQUIRED');
    const still = await storedRequest(documentId);
    expect(still.status).toBe('pending');

    // One direction only: the admin the request was raised under still clears it.
    // (Not self-approval — the owner raised nothing here, the admin did, so the
    // owner decides.)
    const allowed = await call(approvalRequests, owner, company, 'POST', { action: 'approve', requestId });
    expect(allowed.state.statusCode).toBe(200);
  });

  it("refuses the manager when the bound rule is DEACTIVATED instead of re-thresholded", async () => {
    const { company, adminRule, documentId, requestId } = await raisedUnderTheAdminRule();

    const edited = await call(approvalRules, admin, company, 'PUT', { id: adminRule, isActive: false });
    expect(edited.state.statusCode).toBe(200);
    await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });

    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
    expect(reasonOf(bypass)).toBe('APPROVER_ROLE_REQUIRED');
  });
});

describe('HIGH-1 lever B — the bound rule may not be handed down under a pending request', () => {
  it('refuses the manager after the bound rule\'s approver_role is lowered to manager', async () => {
    const { company, adminRule, requestId } = await raisedUnderTheAdminRule();

    // No rebind, no re-POST, no document edit: one PUT the rule-authority guard
    // allows, because an admin may demand `manager`.
    const handedDown = await call(approvalRules, admin, company, 'PUT', { id: adminRule, approverRole: 'manager' });
    expect(handedDown.state.statusCode).toBe(200);
    expect((await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [adminRule])).rows[0].approver_role)
      .toBe('manager');

    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
    expect(reasonOf(bypass)).toBe('APPROVER_ROLE_REQUIRED');
  });

  it('still governs a request raised AFTER the rule was lowered by the new, laxer role', async () => {
    // The ratchet pins a PENDING request, not the rule: a policy change applies
    // to everything raised from then on, or it would be unusable.
    const company = await newCompany();
    const rule = await plantRule(company, 'r6 admin any', 'supplier_invoice', 'admin');
    await call(approvalRules, admin, company, 'PUT', { id: rule, approverRole: 'manager' });
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);

    await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    const stored = await storedRequest(documentId);
    expect(stored.required_role).toBe('manager');

    const decided = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId: stored.id });
    expect(decided.state.statusCode).toBe(200);
  });
});

describe('the ratchet turns upwards', () => {
  it('rebinds a pending request onto a STRICTER rule created after it was raised', async () => {
    const company = await newCompany();
    const managerRule = await plantRule(company, 'r6 manager any', 'supplier_invoice', 'manager');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);

    await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    const first = await storedRequest(documentId);
    expect(first.rule_id).toBe(managerRule);
    expect(first.required_role).toBe('manager');

    // Only the owner can mint an owner-only rule (assertMayDemand).
    const created = await call(approvalRules, owner, company, 'POST', {
      name: 'r6 owner over 100k', documentType: 'supplier_invoice',
      conditionOperator: 'greater_than', conditionValue: 100000, approverRole: 'owner',
    });
    expect(created.state.statusCode).toBe(200);

    await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    const second = await storedRequest(documentId);
    expect(second.id).toBe(first.id);
    expect(second.rule_id).not.toBe(managerRule);
    expect(second.required_role).toBe('owner');

    const tooLow = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId: first.id });
    expect(tooLow.state.statusCode).toBe(403);
    const cleared = await call(approvalRequests, owner, company, 'POST', { action: 'approve', requestId: first.id });
    expect(cleared.state.statusCode).toBe(200);
  });
});

describe('adjacent cases', () => {
  it('governs a legacy pending row carrying no snapshot by the live rule', async () => {
    // Rows raised before migration 669 have required_role NULL. They must keep
    // exactly the authority they had — the bound rule's — not fall to a default.
    const company = await newCompany();
    const ownerRule = await plantRule(company, 'r6 legacy owner', 'supplier_invoice', 'owner');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);
    const requestId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,requested_by,required_role)
       VALUES($1,$2,$3,'supplier_invoice',$4,500000,$5,NULL)`,
      [requestId, company, ownerRule, documentId, admin]);

    const tooLow = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(tooLow.state.statusCode).toBe(403);
    const cleared = await call(approvalRequests, owner, company, 'POST', { action: 'approve', requestId });
    expect(cleared.state.statusCode).toBe(200);
  });

  it("refuses another company's admin the rule edit that would drive the lever at all", async () => {
    const { adminRule, requestId, company } = await raisedUnderTheAdminRule();
    const other = await newCompany();
    const foreign = await call(approvalRules, admin, other, 'PUT', { id: adminRule, approverRole: 'manager' });
    expect(foreign.state.statusCode).toBe(404);
    expect((await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [adminRule])).rows[0].approver_role)
      .toBe('admin');
    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
  });

  it('keeps the snapshot when a re-POST finds the same rule, and refreshes nothing else', async () => {
    const { company, adminRule, documentId, requestId } = await raisedUnderTheAdminRule();
    const before = await storedRequest(documentId);
    await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    const after = await storedRequest(documentId);
    expect(after).toMatchObject({ id: requestId, rule_id: adminRule, required_role: 'admin' });
    expect(Number(after.amount)).toBe(Number(before.amount));
  });
});
