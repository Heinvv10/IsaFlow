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

    const stored = await pool.query(
      'SELECT id FROM approval_rules WHERE company_id=$1 AND name=$2', [alpha, 'Payments over 1000']);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses an update that swaps a good operator for an unreadable one', async () => {
    const created = await call(approvalRules, 'POST', {
      name: 'Payments over 1000 (valid operator)', documentType: 'payment',
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
    // Its own rule, and its own NAME: the refusal test above asserts that no row
    // named 'Payments over 1000' exists, so a second rule sharing that name made
    // the pair order-coupled and red under --sequence.shuffle (review LOW-1).
    await pool.query(
      `INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
       VALUES($1,'fires over 1000','payment','amount','greater_than',1000,'admin')`, [alpha]);

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
      // 'manager', not 'owner': the caller is an admin and may not create a rule
      // demanding a rank above their own (round-4 HIGH-1).
      name: 'Role update', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'manager',
    });
    expect(created.state.statusCode).toBe(200);
    const ruleId = (created.state.body as { data: { id: string } }).data.id;

    const updated = await call(approvalRules, 'PUT', { id: ruleId, approverRole: 'superuser' });
    expect(updated.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].approver_role).toBe('manager');
  });
});

describe('K-109 — a request is governed by this company\'s own rule, never a named one', () => {
  // The route no longer accepts `ruleId`. These assert the property that
  // replaced it: whatever the body says, the stored rule_id is resolved from the
  // company's own active rules or nothing is written at all.
  it("ignores another tenant's rule id and stores nothing when no own rule matches", async () => {
    const betaRule = crypto.randomUUID();
    await pool.query(
      `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
       VALUES($1,$2,'beta only','journal_entry','amount','any',0,'admin')`, [betaRule, beta]);

    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, 'POST', {
      action: 'request', ruleId: betaRule, documentType: 'journal_entry', documentId, amount: 5000,
    });
    expect(made.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it('refuses a document no active rule of this company governs', async () => {
    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, 'POST', {
      action: 'request', documentType: 'credit_note', documentId, amount: 5000,
    });
    expect(made.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rowCount).toBe(0);
  });

  it("resolves the caller's own rule and stores it against the caller's company", async () => {
    const ownRule = crypto.randomUUID();
    await pool.query(
      `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
       VALUES($1,$2,'alpha own','supplier_invoice','amount','any',0,'admin')`, [ownRule, alpha]);

    const documentId = crypto.randomUUID();
    const made = await call(approvalRequests, 'POST', {
      // A foreign rule id in the body is simply not read any more.
      action: 'request', ruleId: crypto.randomUUID(), documentType: 'supplier_invoice', documentId, amount: 5000,
    });
    expect(made.state.statusCode).toBe(200);

    const stored = await pool.query('SELECT company_id, rule_id FROM approval_requests WHERE document_id=$1', [documentId]);
    expect(stored.rows[0]).toMatchObject({ company_id: alpha, rule_id: ownRule });
  });
});

describe('K-108 — a legacy unreadable rule can still be switched off (review LOW-2)', () => {
  /**
   * Migration 647's CHECK is NOT VALID, which Postgres still enforces on any row
   * it UPDATES, and updateRule re-presents condition_operator through COALESCE.
   * An UNSCOPED constraint would therefore refuse an update that only sets
   * is_active = false, with a 23514 the route reported as a 500 — so precisely
   * the rules that now demand approval on every document could not be switched
   * off, only deleted. The constraint is scoped `OR is_active IS NOT TRUE`.
   *
   * Planting the legacy row needs the constraint out of the way, since that is
   * the whole point: it cannot be created through any current path. Dropped and
   * restored in a finally, so a failure here does not leave the fixture open.
   */
  const CONSTRAINT = 'approval_rules_condition_operator_check';

  const plantLegacyRule = async (id: string) => {
    // Read the LIVE definition back out of the catalogue and restore that,
    // rather than restating it here. A copy would silently reinstate the scoped
    // form even when the migration no longer produces it, which makes these
    // tests pass against an unscoped constraint — the exact thing they exist to
    // rule out.
    //
    // Review LOW-2: the drop/insert/restore runs in ONE transaction holding
    // ACCESS EXCLUSIVE on the table, so no concurrent test file ever observes
    // the fixture with the constraint missing. Dropping it at auto-commit left
    // exactly that window open.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE approval_rules IN ACCESS EXCLUSIVE MODE');
      const { rows } = await client.query(
        'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname=$1', [CONSTRAINT]);
      const def = rows[0]?.def as string | undefined;
      if (!def) throw new Error(`${CONSTRAINT} is not on the fixture — apply migration 647 first`);

      await client.query(`ALTER TABLE approval_rules DROP CONSTRAINT ${CONSTRAINT}`);
      await client.query(
        `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
         VALUES($1,$2,'legacy less_than','payment','amount','less_than',1000,'admin',true)`, [id, alpha]);
      await client.query(`ALTER TABLE approval_rules ADD CONSTRAINT ${CONSTRAINT} ${def}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  it('deactivates a rule whose stored operator the allowlist would refuse', async () => {
    const ruleId = crypto.randomUUID();
    await plantLegacyRule(ruleId);

    const updated = await call(approvalRules, 'PUT', { id: ruleId, isActive: false });
    expect(updated.state.statusCode).toBe(200);

    const stored = await pool.query('SELECT is_active, condition_operator FROM approval_rules WHERE id=$1', [ruleId]);
    // Switched off, and its operator left exactly as it was for the impact query.
    expect(stored.rows[0]).toMatchObject({ is_active: false, condition_operator: 'less_than' });
  });

  it('refuses to reactivate it while the operator is still unreadable, as a 400 not a 500', async () => {
    const ruleId = crypto.randomUUID();
    await plantLegacyRule(ruleId);
    await call(approvalRules, 'PUT', { id: ruleId, isActive: false });

    const reactivated = await call(approvalRules, 'PUT', { id: ruleId, isActive: true });
    expect(reactivated.state.statusCode).toBe(400);

    const stored = await pool.query('SELECT is_active FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].is_active).toBe(false);
  });

  it('lets the operator be corrected and the rule brought back', async () => {
    const ruleId = crypto.randomUUID();
    await plantLegacyRule(ruleId);
    await call(approvalRules, 'PUT', { id: ruleId, isActive: false });

    const fixed = await call(approvalRules, 'PUT', { id: ruleId, conditionOperator: 'greater_than', isActive: true });
    expect(fixed.state.statusCode).toBe(200);

    const stored = await pool.query('SELECT is_active, condition_operator FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0]).toMatchObject({ is_active: true, condition_operator: 'greater_than' });
  });
});
