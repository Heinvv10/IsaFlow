/**
 * K-043 round-4 review, HIGH-1: the decide-path authority check was worth
 * nothing while the requester could mint the rule that governed their own
 * request.
 *
 * The reviewer's sequence, end to end: an admin correctly refused a weakening of
 * the owner-only rule (403) simply POSTed a manager-level rule beside it, named
 * that rule when raising the request, and a manager cleared it — 200.
 *
 * Two halves close it. A rule may not be created or moved to a rank the actor
 * does not hold, and the governing rule is RESOLVED server-side from the
 * document and its amount — the strictest match wins, so a laxer rule created
 * beside an owner-only one cannot shadow it whichever way the tiebreak runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const alpha = crypto.randomUUID();
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
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [alpha, 'K043r4 alpha']);
  for (const [id, role] of [[admin, 'admin'], [manager, 'manager'], [owner, 'owner']] as const) {
    // users.role is the platform role and has its own CHECK; the per-company
    // role the guards rank lives in company_users.
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@test.local`]);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [alpha, id, role]);
    tokens[id] = await sign(id);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [alpha]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=$1', [alpha]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=$1', [alpha]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [alpha]);
    await pool.query('DELETE FROM companies WHERE id=$1', [alpha]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [users]);
  } finally {
    await pool.end();
  }
});

function call(handler: typeof approvalRules, as: string, method: string, body: unknown, query: Record<string, string> = {}) {
  const req = request({ 'sb-access-token': tokens[as]!, active_company_id: alpha }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = query;
  req.url = '/api/accounting/approval-rules';
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

const idOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { data: { id: string } }).data.id;
const reasonOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

async function plantRule(name: string, documentType: string, approverRole: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES($1,$2,$3,$4,'amount','any',0,$5,true)`, [id, alpha, name, documentType, approverRole]);
  return id;
}

describe('HIGH-1 — the round-4 separation-of-duties bypass, reproduced end to end', () => {
  it('the admin who cannot weaken the owner-only rule cannot route around it either', async () => {
    const ownerRule = await plantRule('r4 owner only', 'supplier_invoice', 'owner');

    // Step 1 — the round-3 guard, unchanged: the rule cannot be weakened.
    const weakened = await call(approvalRules, admin, 'PUT', { id: ownerRule, approverRole: 'viewer' });
    expect(weakened.state.statusCode).toBe(403);

    // Step 2 — the door the reviewer walked through. An admin may still create a
    // manager-level rule; that is ordinary administration and stays a 200.
    const created = await call(approvalRules, admin, 'POST', {
      name: 'r4 manager level', documentType: 'supplier_invoice',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'manager',
    });
    expect(created.state.statusCode).toBe(200);
    const managerRule = idOf(created);

    // Step 3 — raising the request while naming the new rule. The body is no
    // longer read: the owner-only rule is resolved and stored.
    const documentId = crypto.randomUUID();
    const raised = await call(approvalRequests, admin, 'POST', {
      action: 'request', ruleId: managerRule,
      documentType: 'supplier_invoice', documentId, amount: 250000,
    });
    expect(raised.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT id, rule_id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
    expect(stored.rows[0].rule_id).not.toBe(managerRule);

    // Step 4 — the step that used to be a 200. The manager does not outrank the
    // rule that actually governs the document.
    const requestId = stored.rows[0].id as string;
    const bypass = await call(approvalRequests, manager, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
    expect(reasonOf(bypass)).toBe('APPROVER_ROLE_REQUIRED');
    const still = await pool.query('SELECT status, decided_by FROM approval_requests WHERE id=$1', [requestId]);
    expect(still.rows[0]).toMatchObject({ status: 'pending', decided_by: null });

    // Step 5 — and the legitimate path is not collateral damage: the owner the
    // rule demands still clears it.
    const allowed = await call(approvalRequests, owner, 'POST', { action: 'approve', requestId });
    expect(allowed.state.statusCode).toBe(200);
    const decided = await pool.query('SELECT status, decided_by FROM approval_requests WHERE id=$1', [requestId]);
    expect(decided.rows[0]).toMatchObject({ status: 'approved', decided_by: owner });
  });

  it('a manager-only document is still governed and decided by a manager', async () => {
    // The guard has to fail in one direction only. Nothing owner-level covers
    // credit notes, so the manager rule governs and the manager may clear it.
    const managerRule = await plantRule('r4 manager only', 'credit_note', 'manager');

    const documentId = crypto.randomUUID();
    const raised = await call(approvalRequests, admin, 'POST', {
      action: 'request', documentType: 'credit_note', documentId, amount: 500,
    });
    expect(raised.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT id, rule_id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0].rule_id).toBe(managerRule);

    const decided = await call(approvalRequests, manager, 'POST', { action: 'approve', requestId: stored.rows[0].id });
    expect(decided.state.statusCode).toBe(200);
  });

  it('resolves the strictest rule whichever order the two were created in', async () => {
    // Insertion order is the tiebreak among equal ranks, so the lax rule is
    // created FIRST here: under "first match wins" it would have governed.
    await plantRule('r4 lax first', 'journal_entry', 'viewer');
    const ownerRule = await plantRule('r4 strict second', 'journal_entry', 'owner');

    const documentId = crypto.randomUUID();
    const raised = await call(approvalRequests, admin, 'POST', {
      action: 'request', documentType: 'journal_entry', documentId, amount: 10,
    });
    expect(raised.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT rule_id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
  });

  it('a second request for the same document returns the first, it does not re-choose a rule', async () => {
    // customer_invoice, a document type no other test in this file touches: two
    // rules of EQUAL rank tie, and the tiebreak is creation order, so sharing a
    // type with the rank block below made this order-coupled.
    const ownerRule = await plantRule('r4 idempotent', 'customer_invoice', 'owner');
    const documentId = crypto.randomUUID();

    const first = await call(approvalRequests, admin, 'POST', {
      action: 'request', documentType: 'customer_invoice', documentId, amount: 1,
    });
    expect(first.state.statusCode).toBe(200);
    const second = await call(approvalRequests, admin, 'POST', {
      action: 'request', documentType: 'customer_invoice', documentId, amount: 1,
    });
    expect(second.state.statusCode).toBe(200);
    expect(idOf(second)).toBe(idOf(first));

    const stored = await pool.query('SELECT id, rule_id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
  });
});

describe('HIGH-1 — a rule may not be created or moved above the actor\'s own rank', () => {
  it('refuses an admin creating an owner-only rule and stores nothing', async () => {
    const res = await call(approvalRules, admin, 'POST', {
      name: 'r4 admin mints owner', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'owner',
    });
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    const stored = await pool.query('SELECT id FROM approval_rules WHERE company_id=$1 AND name=$2',
      [alpha, 'r4 admin mints owner']);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses a manager creating an admin-level rule', async () => {
    const res = await call(approvalRules, manager, 'POST', {
      name: 'r4 manager mints admin', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'admin',
    });
    expect(res.state.statusCode).toBe(403);
    const stored = await pool.query('SELECT id FROM approval_rules WHERE company_id=$1 AND name=$2',
      [alpha, 'r4 manager mints admin']);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses an admin RAISING an admin-level rule to owner, and leaves the role', async () => {
    const ruleId = await plantRule('r4 raise to owner', 'payment', 'admin');
    const res = await call(approvalRules, admin, 'PUT', { id: ruleId, approverRole: 'owner' });
    expect(res.state.statusCode).toBe(403);
    const stored = await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].approver_role).toBe('admin');
  });

  it('lets the owner create the owner-only rule, and the admin an admin-level one', async () => {
    const byOwner = await call(approvalRules, owner, 'POST', {
      name: 'r4 owner mints owner', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'owner',
    });
    expect(byOwner.state.statusCode).toBe(200);

    const byAdmin = await call(approvalRules, admin, 'POST', {
      name: 'r4 admin mints admin', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'admin',
    });
    expect(byAdmin.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [idOf(byAdmin)]);
    expect(stored.rows[0].approver_role).toBe('admin');
  });

  it('defaults an unspecified role to admin and ranks THAT, so a manager is refused', async () => {
    // The INSERT defaults approver_role to 'admin'; ranking only what the caller
    // typed would let a manager create an admin-level rule by omitting it.
    const res = await call(approvalRules, manager, 'POST', {
      name: 'r4 manager omits role', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0,
    });
    expect(res.state.statusCode).toBe(403);
    const stored = await pool.query('SELECT id FROM approval_rules WHERE company_id=$1 AND name=$2',
      [alpha, 'r4 manager omits role']);
    expect(stored.rowCount).toBe(0);
  });
});
