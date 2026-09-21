/**
 * K-043 round-5 review.
 *
 * HIGH-1: `amount` came out of the request body, and checkApproval filters the
 * candidate rules by the operator/threshold comparison BEFORE the strictest-wins
 * ranking runs — so a rule that does not match is not a rule the ranking can
 * pick. An admin POSTing `amount: 1` for a R500 000 supplier invoice bound the
 * request to the manager rule and a manager cleared it, 200. The idempotency
 * short-circuit then PINNED it: a later honest request returned the
 * manager-governed row.
 *
 * HIGH-2: the same lever one level up. `documentType` was caller-supplied and
 * `documentId` was never verified to exist, so the caller swapped the whole
 * candidate set — and minted approval records against ids in no table at all.
 *
 * MEDIUM-1: "one pending request per document" was a comment; two concurrent
 * POSTs left two pending rows under different rules.
 * MEDIUM-2: deleting a used rule was a 23503 reported as a 500 carrying the raw
 * Postgres constraint message.
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

/**
 * Every case gets its OWN company. Rules are matched by document type across the
 * whole company, so sharing one made each test depend on which rules the tests
 * before it had left behind — the order coupling an earlier round already had to
 * fix once.
 */
async function newCompany(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `K043r5 ${id.slice(0, 8)}`]);
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

describe('HIGH-1 — the amount is read from the document, not from the request', () => {
  it('binds the owner rule to an understated request, and the manager still cannot clear it', async () => {
    const company = await newCompany();
    // The reviewer's exact pair of rules.
    const ownerRule = await plantRule(company, 'r5 owner over 100k', 'supplier_invoice', 'owner', 'greater_than', 100000);
    const managerRule = await plantRule(company, 'r5 manager any', 'supplier_invoice', 'manager');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);

    // The bypass: `amount: 1` for a R500 000 invoice. It used to bind the manager rule.
    const raised = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId, amount: 1,
    });
    expect(raised.state.statusCode).toBe(200);

    const stored = await pool.query('SELECT id, rule_id, amount FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
    expect(stored.rows[0].rule_id).not.toBe(managerRule);
    // The stored amount is the document's, not the caller's.
    expect(Number(stored.rows[0].amount)).toBe(500000);

    const requestId = stored.rows[0].id as string;
    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
    expect(reasonOf(bypass)).toBe('APPROVER_ROLE_REQUIRED');
    const still = await pool.query('SELECT status, decided_by FROM approval_requests WHERE id=$1', [requestId]);
    expect(still.rows[0]).toMatchObject({ status: 'pending', decided_by: null });

    // The guard must fail in ONE direction only: the owner the rule demands clears it.
    const allowed = await call(approvalRequests, owner, company, 'POST', { action: 'approve', requestId });
    expect(allowed.state.statusCode).toBe(200);
    const decided = await pool.query('SELECT status, decided_by FROM approval_requests WHERE id=$1', [requestId]);
    expect(decided.rows[0]).toMatchObject({ status: 'approved', decided_by: owner });
  });

  it('lets an honestly small invoice be governed and cleared by the manager rule', async () => {
    const company = await newCompany();
    // The mirror case. Below the owner threshold, the manager rule IS the
    // strictest match and a manager may decide it.
    await plantRule(company, 'r5 small owner over 100k', 'customer_invoice', 'owner', 'greater_than', 100000);
    const managerRule = await plantRule(company, 'r5 small manager any', 'customer_invoice', 'manager');
    const documentId = await plantDocument(pool, company, 'customer_invoice', 250, admin);

    // An OVERSTATED body amount must not raise the bar either.
    const raised = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'customer_invoice', documentId, amount: 900000,
    });
    expect(raised.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT id, rule_id, amount FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0].rule_id).toBe(managerRule);
    expect(Number(stored.rows[0].amount)).toBe(250);

    const decided = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId: stored.rows[0].id });
    expect(decided.state.statusCode).toBe(200);
  });

  it('does not let an understated first request pin the authority of a later honest one', async () => {
    const company = await newCompany();
    const ownerRule = await plantRule(company, 'r5 pin owner', 'payment', 'owner', 'greater_than', 100000);
    const managerRule = await plantRule(company, 'r5 pin manager', 'payment', 'manager');
    const documentId = await plantDocument(pool, company, 'payment', 500000, admin);

    const first = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'payment', documentId, amount: 1,
    });
    expect(first.state.statusCode).toBe(200);

    // Plant the pinned state directly: a row bound to the manager rule at the
    // understated amount, exactly what the pre-fix path left behind.
    const requestId = (first.state.body as { data: { id: string } }).data.id;
    await pool.query('UPDATE approval_requests SET rule_id=$1, amount=1 WHERE id=$2', [managerRule, requestId]);

    const second = await call(approvalRequests, owner, company, 'POST', {
      action: 'request', documentType: 'payment', documentId,
    });
    expect(second.state.statusCode).toBe(200);

    const stored = await pool.query('SELECT id, rule_id, amount FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].id).toBe(requestId);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
    expect(Number(stored.rows[0].amount)).toBe(500000);

    // And the re-bound row is genuinely owner-governed.
    const bypass = await call(approvalRequests, manager, company, 'POST', { action: 'approve', requestId });
    expect(bypass.state.statusCode).toBe(403);
  });
});

describe('HIGH-2 — the document must exist, in this company, as the declared type', () => {
  it('refuses a documentId that names nothing and writes no request', async () => {
    const company = await newCompany();
    await plantRule(company, 'r5 ghost je', 'journal_entry', 'accountant');
    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'journal_entry', documentId, amount: 500000,
    });
    expect(made.state.statusCode).toBe(400);
    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses a document declared as a type it is not', async () => {
    const company = await newCompany();
    await plantRule(company, 'r5 mistyped je', 'journal_entry', 'accountant');
    await plantRule(company, 'r5 mistyped si', 'supplier_invoice', 'owner');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);

    const made = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'journal_entry', documentId,
    });
    expect(made.state.statusCode).toBe(400);
    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it("refuses another company's document", async () => {
    const company = await newCompany();
    await plantRule(company, 'r5 foreign cn', 'credit_note', 'manager');
    const documentId = await plantDocument(pool, await newCompany(), 'credit_note', 5000, admin);
    const made = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'credit_note', documentId,
    });
    expect(made.state.statusCode).toBe(400);
    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it('resolves a journal entry by the sum of its debits', async () => {
    const company = await newCompany();
    const ownerRule = await plantRule(company, 'r5 je owner over 100k', 'journal_entry', 'owner', 'greater_than', 100000);
    await plantRule(company, 'r5 je manager any', 'journal_entry', 'manager');
    const documentId = await plantDocument(pool, company, 'journal_entry', 300000, admin);

    const made = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'journal_entry', documentId, amount: 1,
    });
    expect(made.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT rule_id, amount FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
    expect(Number(stored.rows[0].amount)).toBe(300000);
  });

  it('answers ?action=check from the document, not from the query amount', async () => {
    const company = await newCompany();
    const ownerRule = await plantRule(company, 'r5 check owner over 100k', 'customer_invoice', 'owner', 'greater_than', 100000);
    const documentId = await plantDocument(pool, company, 'customer_invoice', 500000, admin);

    const checked = await call(approvalRequests, admin, company, 'GET', {},
      { action: 'check', documentType: 'customer_invoice', documentId, amount: '1' });
    expect(checked.state.statusCode).toBe(200);
    const body = checked.state.body as { data: { matchedRule: { id: string } | null } };
    expect(body.data.matchedRule?.id).toBe(ownerRule);

    const ghost = await call(approvalRequests, admin, company, 'GET', {},
      { action: 'check', documentType: 'customer_invoice', documentId: crypto.randomUUID() });
    expect(ghost.state.statusCode).toBe(400);
  });
});

describe('MEDIUM-1 — one pending request per document is enforced by the database', () => {
  it('leaves exactly one pending row when two requests race', async () => {
    const company = await newCompany();
    const ownerRule = await plantRule(company, 'r5 race owner', 'payment', 'owner', 'greater_than', 100000);
    const documentId = await plantDocument(pool, company, 'payment', 500000, admin);

    const [a, b] = await Promise.all([
      call(approvalRequests, admin, company, 'POST', { action: 'request', documentType: 'payment', documentId }),
      call(approvalRequests, manager, company, 'POST', { action: 'request', documentType: 'payment', documentId }),
    ]);
    expect([a.state.statusCode, b.state.statusCode]).toEqual([200, 200]);

    const stored = await pool.query(
      "SELECT rule_id FROM approval_requests WHERE document_id=$1 AND status='pending'", [documentId]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].rule_id).toBe(ownerRule);
  });

  it('the database refuses a second pending row for the same document', async () => {
    // The route's SELECT-then-INSERT has a window, so the invariant has to be
    // the constraint, not the read. Two concurrent POSTs are timing-dependent;
    // a direct second write is not, and it is the same statement the loser of
    // the race issues.
    const company = await newCompany();
    const ruleId = await plantRule(company, 'r5 uq owner', 'supplier_invoice', 'owner');
    const documentId = await plantDocument(pool, company, 'supplier_invoice', 500000, admin);

    const first = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'supplier_invoice', documentId,
    });
    expect(first.state.statusCode).toBe(200);

    await expect(pool.query(
      `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,status,requested_by)
       VALUES($1,$2,$3,'supplier_invoice',$4,500000,'pending',$5)`,
      [crypto.randomUUID(), company, ruleId, documentId, manager],
    )).rejects.toThrow(/uq_approval_requests_pending/);

    const stored = await pool.query(
      "SELECT id FROM approval_requests WHERE document_id=$1 AND status='pending'", [documentId]);
    expect(stored.rowCount).toBe(1);
  });

  it('lets a document be re-requested once its earlier request was decided', async () => {
    const company = await newCompany();
    // The index is partial: only pending rows are constrained.
    await plantRule(company, 'r5 requeue owner', 'credit_note', 'owner');
    const documentId = await plantDocument(pool, company, 'credit_note', 900, admin);

    const first = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'credit_note', documentId,
    });
    expect(first.state.statusCode).toBe(200);
    const requestId = (first.state.body as { data: { id: string } }).data.id;
    const rejected = await call(approvalRequests, owner, company, 'POST', { action: 'reject', requestId });
    expect(rejected.state.statusCode).toBe(200);

    const second = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'credit_note', documentId,
    });
    expect(second.state.statusCode).toBe(200);
    expect((second.state.body as { data: { id: string } }).data.id).not.toBe(requestId);
    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(2);
  });
});

describe('MEDIUM-2 — deleting a rule that has requests is a 400, not a 500 with the raw FK message', () => {
  it('refuses the delete and says to deactivate instead', async () => {
    const company = await newCompany();
    await plantRule(company, 'r5 delete me', 'customer_invoice', 'admin');
    const created = await call(approvalRules, admin, company, 'POST', {
      name: 'r5 used rule', documentType: 'customer_invoice',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'admin',
    });
    expect(created.state.statusCode).toBe(200);
    const ruleId = (created.state.body as { data: { id: string } }).data.id;
    // Bind a request to it directly: which of the two admin-level rules the
    // resolver picks is a tiebreak, and this test is about the DELETE.
    await pool.query(
      `INSERT INTO approval_requests(id,company_id,rule_id,document_type,document_id,amount,status,requested_by)
       VALUES($1,$2,$3,'customer_invoice',$4,100,'pending',$5)`,
      [crypto.randomUUID(), company, ruleId, crypto.randomUUID(), admin]);

    const deleted = await call(approvalRules, admin, company, 'DELETE', { id: ruleId }, { id: ruleId });
    expect(deleted.state.statusCode).toBe(400);
    const message = (deleted.state.body as { error?: { message?: string } }).error?.message ?? '';
    expect(message).toContain('cannot be deleted');
    expect(message).not.toContain('approval_requests_rule_id_fkey');

    const stored = await pool.query('SELECT id FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rowCount).toBe(1);
  });
});

describe('LOW-1 — an inactive rule is never bound to a request', () => {
  it('refuses the request when the only governing rule has been deactivated', async () => {
    const company = await newCompany();
    const ruleId = await plantRule(company, 'r5 low1 rule', 'journal_entry', 'owner', 'greater_than', 100000);
    const documentId = await plantDocument(pool, company, 'journal_entry', 500000, admin);
    await pool.query('UPDATE approval_rules SET is_active=false WHERE id=$1', [ruleId]);

    const made = await call(approvalRequests, admin, company, 'POST', {
      action: 'request', documentType: 'journal_entry', documentId,
    });
    expect(made.state.statusCode).toBe(400);
    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });
});
