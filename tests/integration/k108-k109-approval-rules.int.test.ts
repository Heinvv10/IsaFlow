// Regression: K-108 — an unknown condition_operator silently never matched, so a
// rule the UI showed as active required no approval at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const alpha = crypto.randomUUID();
const beta = crypto.randomUUID();
const user = crypto.randomUUID();
const companies = [alpha, beta];
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [alpha, 'K108 alpha', beta, 'K108 beta']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [alpha, user]);
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM approval_requests WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally {
    await pool.end();
  }
});

function call(handler: typeof approvalRules, method: string, body: unknown, query: Record<string, string> = {}) {
  const req = request({ 'sb-access-token': token, active_company_id: alpha }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = query;
  req.url = '/api/accounting/approval-rules';
  const result = response();
  return handler(req as never, result.res).then(() => result);
}

describe('K-108 — condition_operator allowlist', () => {
  it('refuses a rule created with an operator checkApproval cannot evaluate', async () => {
    const created = await call(approvalRules, 'POST', {
      name: 'Payments over 1000', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'gt', conditionValue: 1000, approverRole: 'admin',
    });
    expect(created.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT id FROM approval_rules WHERE company_id=$1', [alpha]);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses an update that swaps a good operator for an unreadable one', async () => {
    const created = await call(approvalRules, 'POST', {
      name: 'Payments over 1000', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'greater_than', conditionValue: 1000, approverRole: 'admin',
    });
    expect(created.state.statusCode).toBe(200);
    const ruleId = (created.state.body as { data: { id: string } }).data.id;

    const updated = await call(approvalRules, 'PUT', { id: ruleId, conditionOperator: 'gt' });
    expect(updated.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT condition_operator FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].condition_operator).toBe('greater_than');
  });

  it('the rule the UI describes actually fires once the operator is a real one', async () => {
    const checked = await call(approvalRequests, 'GET', undefined, {
      action: 'check', documentType: 'payment', documentId: crypto.randomUUID(), amount: '999999',
    });
    const payload = checked.state.body as { data: { requiresApproval: boolean } };
    expect(payload.data.requiresApproval).toBe(true);
  });

  it('the database refuses an unreadable operator even when the route is bypassed', async () => {
    await expect(pool.query(
      `INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
       VALUES($1,'direct write','payment','amount','gt',1000,'admin')`, [alpha],
    )).rejects.toThrow(/approval_rules_condition_operator_check/);
  });
});

describe('K-108 — approver_role allowlist (review L4)', () => {
  it('refuses a rule created with a role the rank ladder does not know', async () => {
    const created = await call(approvalRules, 'POST', {
      name: 'Typed role', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'Owner',
    });
    expect(created.state.statusCode).toBe(400);
    const stored = await pool.query('SELECT id FROM approval_rules WHERE company_id=$1 AND name=$2', [alpha, 'Typed role']);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses an update that swaps a real role for an unknown one', async () => {
    const created = await call(approvalRules, 'POST', {
      name: 'Role update', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'owner',
    });
    expect(created.state.statusCode).toBe(200);
    const ruleId = (created.state.body as { data: { id: string } }).data.id;

    const updated = await call(approvalRules, 'PUT', { id: ruleId, approverRole: 'superuser' });
    expect(updated.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].approver_role).toBe('owner');
  });
});

describe('K-109 — a request may only name a rule this company owns', () => {
  it("refuses another tenant's rule id and stores nothing", async () => {
    const betaRule = crypto.randomUUID();
    await pool.query(
      `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
       VALUES($1,$2,'beta only','payment','amount','any',0,'admin')`, [betaRule, beta]);

    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, 'POST', {
      action: 'request', ruleId: betaRule, documentType: 'payment', documentId, amount: 5000,
    });
    expect(made.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses a rule id that exists nowhere', async () => {
    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, 'POST', {
      action: 'request', ruleId: crypto.randomUUID(), documentType: 'payment', documentId, amount: 5000,
    });
    expect(made.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it("accepts the caller's own rule id and stores it against the caller's company", async () => {
    const ownRule = crypto.randomUUID();
    await pool.query(
      `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
       VALUES($1,$2,'alpha own','payment','amount','any',0,'admin')`, [ownRule, alpha]);

    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, 'POST', {
      action: 'request', ruleId: ownRule, documentType: 'payment', documentId, amount: 5000,
    });
    expect(made.state.statusCode).toBe(200);

    const stored = await pool.query('SELECT company_id, rule_id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0]).toMatchObject({ company_id: alpha, rule_id: ownRule });
  });
});
