// K-043 round-3 review: the rule an approval leans on is editable through an
// unprivileged route by the very people it constrains (HIGH-2), migration 647
// cannot repair a database that ran its earlier form (HIGH-1), and three ids
// still reach a `::UUID` cast unvalidated (MEDIUM-1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const alpha = crypto.randomUUID();
const beta = crypto.randomUUID();
const admin = crypto.randomUUID();
const owner = crypto.randomUUID();
const companies = [alpha, beta];
const users = [admin, owner];
const tokens: Record<string, string> = {};

const sign = (id: string) => new SignJWT({ sub: id, aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [alpha, 'K043r3 alpha', beta, 'K043r3 beta']);
  for (const [id, role] of [[admin, 'admin'], [owner, 'owner']] as const) {
    // users.role has its own CHECK and is the platform role; the per-company
    // role the guard ranks lives in company_users.
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@test.local`]);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [alpha, id, role]);
    tokens[id] = await sign(id);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM approval_requests WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM approval_rules WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
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

async function plantRule(companyId: string, name: string, approverRole: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
     VALUES($1,$2,$3,'payment','amount','any',0,$4,true)`, [id, companyId, name, approverRole]);
  return id;
}

const reasonOf = (result: Awaited<ReturnType<typeof call>>) =>
  (result.state.body as { error?: { details?: { reason?: string } } }).error?.details?.reason;

describe('HIGH-2 — an admin cannot weaken a rule that demands more than they hold', () => {
  it('refuses to deactivate an owner-only rule and leaves it active', async () => {
    const ruleId = await plantRule(alpha, 'owner only deactivate', 'owner');
    const res = await call(approvalRules, admin, 'PUT', { id: ruleId, isActive: false });
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    const stored = await pool.query('SELECT is_active FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].is_active).toBe(true);
  });

  it('refuses to lower an owner-only rule to the admin\'s own role', async () => {
    const ruleId = await plantRule(alpha, 'owner only lower', 'owner');
    const res = await call(approvalRules, admin, 'PUT', { id: ruleId, approverRole: 'admin' });
    expect(res.state.statusCode).toBe(403);
    const stored = await pool.query('SELECT approver_role FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].approver_role).toBe('owner');
  });

  it('refuses to delete an owner-only rule and leaves the row', async () => {
    const ruleId = await plantRule(alpha, 'owner only delete', 'owner');
    const res = await call(approvalRules, admin, 'DELETE', { id: ruleId });
    expect(res.state.statusCode).toBe(403);
    const stored = await pool.query('SELECT id FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rowCount).toBe(1);
  });

  // The guard must not lock out legitimate administration, which is the whole
  // reason it ranks rather than demanding 'owner' for every write.
  it('lets the same admin edit an admin-level rule', async () => {
    const ruleId = await plantRule(alpha, 'admin level', 'admin');
    const res = await call(approvalRules, admin, 'PUT', { id: ruleId, isActive: false });
    expect(res.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT is_active FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].is_active).toBe(false);
  });

  it('lets an owner deactivate the owner-only rule', async () => {
    const ruleId = await plantRule(alpha, 'owner clears own', 'owner');
    const res = await call(approvalRules, owner, 'PUT', { id: ruleId, isActive: false });
    expect(res.state.statusCode).toBe(200);
    const stored = await pool.query('SELECT is_active FROM approval_rules WHERE id=$1', [ruleId]);
    expect(stored.rows[0].is_active).toBe(false);
  });

  it('records every rule change in audit_log, since approval_rules keeps no history', async () => {
    const created = await call(approvalRules, owner, 'POST', {
      name: 'audited rule', documentType: 'payment',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'owner',
    });
    expect(created.state.statusCode).toBe(200);
    const ruleId = (created.state.body as { data: { id: string } }).data.id;

    expect((await call(approvalRules, owner, 'PUT', { id: ruleId, approverRole: 'manager' })).state.statusCode).toBe(200);
    expect((await call(approvalRules, owner, 'DELETE', { id: ruleId })).state.statusCode).toBe(200);

    const trail = await pool.query(
      `SELECT action, user_id, changes FROM audit_log
       WHERE company_id=$1 AND entity_type='approval_rule' AND entity_id=$2 ORDER BY created_at`,
      [alpha, ruleId]);
    expect(trail.rows.map(r => r.action)).toEqual(['create', 'update', 'delete']);
    expect(trail.rows.every(r => r.user_id === owner)).toBe(true);
    const roleChange = (trail.rows[1].changes as { fields: { field: string; old: string; new: string }[] })
      .fields.find(f => f.field === 'approver_role');
    expect(roleChange).toMatchObject({ old: 'owner', new: 'manager' });
  });
});

describe('MEDIUM-1 / LOW-4 — malformed and foreign ids', () => {
  it('answers 400, not 500, for a PUT id that is not a UUID', async () => {
    const res = await call(approvalRules, admin, 'PUT', { id: 'abc', isActive: false });
    expect(res.state.statusCode).toBe(400);
  });

  it('answers 400, not 500, for a DELETE id that is not a UUID', async () => {
    const res = await call(approvalRules, admin, 'DELETE', { id: 'abc' });
    expect(res.state.statusCode).toBe(400);
  });

  it('answers 400, not 500, for a check documentId that is not a UUID', async () => {
    const req = request({ 'sb-access-token': tokens[admin]!, active_company_id: alpha }, 'GET') as never as {
      query: Record<string, string>; url: string;
    };
    req.query = { action: 'check', documentType: 'payment', documentId: 'abc', amount: '10' };
    req.url = '/api/accounting/approval-requests';
    const result = response();
    await approvalRequests(req as never, result.res);
    expect(result.state.statusCode).toBe(400);
  });

  it("answers 404 for another tenant's rule id and leaves that rule alone", async () => {
    const foreign = await plantRule(beta, 'beta rule', 'admin');
    const res = await call(approvalRules, admin, 'DELETE', { id: foreign });
    expect(res.state.statusCode).toBe(404);
    const stored = await pool.query('SELECT id FROM approval_rules WHERE id=$1', [foreign]);
    expect(stored.rowCount).toBe(1);
  });

  it('answers 404, not 200, for a PUT naming a rule that exists nowhere', async () => {
    const res = await call(approvalRules, admin, 'PUT', { id: crypto.randomUUID(), isActive: false });
    expect(res.state.statusCode).toBe(404);
  });
});

describe('HIGH-1 — migration 658 repairs a database that ran the earlier 647', () => {
  /**
   * 647's guard tests the constraint NAME, so a database carrying the pre-edit
   * (unscoped) form keeps it forever and re-running 647 is a no-op. 658 tests the
   * DEFINITION instead.
   *
   * Run inside a transaction that always ROLLBACKs: DDL is transactional in
   * Postgres, so this proves convergence on the real table without leaving the
   * shared fixture altered for any test running beside it.
   *
   * Every starting state is CONSTRUCTED here rather than read off the fixture,
   * and the transaction takes the lock DDL needs up front: k108-k109's suite
   * drops and re-adds this same constraint at auto-commit on the shared
   * database, so an ambient read is a race, not a fact.
   */
  const MIGRATION = readFileSync('scripts/migrations/sql/658_approval_rules_operator_check_rescope.sql', 'utf8');
  const DEF = `SELECT oid, pg_get_constraintdef(oid) AS def FROM pg_constraint
               WHERE conname='approval_rules_condition_operator_check'
                 AND conrelid='approval_rules'::regclass`;
  const DROP = 'ALTER TABLE approval_rules DROP CONSTRAINT IF EXISTS approval_rules_condition_operator_check;';
  const UNSCOPED = `${DROP}
    ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_condition_operator_check
      CHECK (condition_operator IN ('any','greater_than','greater_equal')) NOT VALID;`;
  const SCOPED = `${DROP}
    ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_condition_operator_check
      CHECK (condition_operator IN ('any','greater_than','greater_equal')
             OR is_active IS NOT TRUE) NOT VALID;`;

  type Snapshot = { oid: number | undefined; def: string | undefined };
  const snapshot = async (client: import('pg').PoolClient): Promise<Snapshot> => {
    const row = (await client.query(DEF)).rows[0];
    return { oid: row?.oid as number | undefined, def: row?.def as string | undefined };
  };

  const converges = async (setup: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE approval_rules IN ACCESS EXCLUSIVE MODE');
      await client.query(setup);
      const start = await snapshot(client);
      await client.query(MIGRATION);
      const first = await snapshot(client);
      // Idempotent by definition: a second run must not drop and re-add, which
      // the oid proves in a way the text of the definition cannot.
      await client.query(MIGRATION);
      const second = await snapshot(client);
      return { start, first, second };
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  it('rescopes the unscoped constraint a pre-edit 647 left behind', async () => {
    const { start, first, second } = await converges(UNSCOPED);
    expect(start.def).not.toContain('is_active');
    expect(first.def).toContain('is_active IS NOT TRUE');
    expect(second).toEqual(first);
  });

  it('adds the constraint on a database that has none', async () => {
    const { start, first, second } = await converges(DROP);
    expect(start.def).toBeUndefined();
    expect(first.def).toContain('is_active IS NOT TRUE');
    expect(second).toEqual(first);
  });

  it('leaves an already-scoped constraint untouched, same oid', async () => {
    const { start, first, second } = await converges(SCOPED);
    expect(start.def).toContain('is_active IS NOT TRUE');
    // Same oid: the constraint was never dropped and re-added.
    expect(first).toEqual(start);
    expect(second).toEqual(start);
  });

  it('a rescoped database can deactivate a legacy unreadable rule', async () => {
    // The consequence the scoping exists to prevent, end to end. The legacy row
    // has to be inserted while the constraint is OFF — that is the whole point of
    // it: no current path can create one. NOT VALID then leaves it in place
    // unchecked, and enforces on the UPDATE.
    const plantLegacy = async (client: import('pg').PoolClient, id: string) => {
      await client.query('LOCK TABLE approval_rules IN ACCESS EXCLUSIVE MODE');
      await client.query(DROP);
      await client.query(
        `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
         VALUES($1,$2,'legacy','payment','amount','gt',0,'admin',true)`, [id, alpha]);
      await client.query(`ALTER TABLE approval_rules ADD CONSTRAINT approval_rules_condition_operator_check
        CHECK (condition_operator IN ('any','greater_than','greater_equal')) NOT VALID`);
    };
    const deactivate = 'UPDATE approval_rules SET condition_operator=COALESCE(NULL,condition_operator), is_active=false WHERE id=$1 RETURNING is_active';

    const unrepaired = await pool.connect();
    try {
      await unrepaired.query('BEGIN');
      const legacy = crypto.randomUUID();
      await plantLegacy(unrepaired, legacy);
      await expect(unrepaired.query(deactivate, [legacy]))
        .rejects.toThrow(/approval_rules_condition_operator_check/);
    } finally {
      await unrepaired.query('ROLLBACK').catch(() => undefined);
      unrepaired.release();
    }

    const repaired = await pool.connect();
    try {
      await repaired.query('BEGIN');
      const legacy = crypto.randomUUID();
      await plantLegacy(repaired, legacy);
      await repaired.query(MIGRATION);
      const off = await repaired.query(deactivate, [legacy]);
      expect(off.rows[0].is_active).toBe(false);
    } finally {
      await repaired.query('ROLLBACK').catch(() => undefined);
      repaired.release();
    }
  });
});
