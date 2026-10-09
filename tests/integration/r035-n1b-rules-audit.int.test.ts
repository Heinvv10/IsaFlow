/**
 * R-035 N1b (B, migration 881): the audit rows the definers write are the rows
 * the TypeScript wrote before (auditRuleChange, auditEnforcement): same
 * action, entity, reference and `changes` — one field entry per audited column
 * that moved, each value as String() rendered it, `metadata.actorRole` the
 * actor's company role, and for a switch its id (and the strictest rule's role
 * when switching off). Each is driven through the real route as a person who
 * may do it, so the legitimate flow is proven to still work as well.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { asRole } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '', manager: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, Object.values(u)));

const company = () => newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin'], [u.manager, 'manager']], companies);
const rules = (as: string, c: string, method: string, body: unknown) =>
  callRoute(approvalRules, tokens[as]!, c, method, body, '/api/accounting/approval-rules');
const enforcement = (as: string, c: string, body: unknown) =>
  callRoute(approvalEnforcement, tokens[as]!, c, 'POST', body, '/api/accounting/approval-enforcement');
const audits = async (c: string, type: string) => (await pool.query(
  `SELECT user_id, user_email, action, entity_id::TEXT, entity_ref, changes FROM audit_log
   WHERE company_id = $1 AND entity_type = $2 ORDER BY created_at, action, entity_ref DESC`, [c, type])).rows;
const field = (name: string, old: string | null, next: string | null) => ({ field: name, old, new: next, label: name });

describe('rule writes', () => {
  it('create: 200, the name stored trimmed, every audited field from null', async () => {
    const c = await company();
    const res = await rules(u.admin, c, 'POST', {
      name: '  Big bills  ', documentType: 'supplier_invoice', conditionOperator: 'greater_equal', conditionValue: 1000,
      approverRole: 'manager' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const id = dataOf<{ id: string }>(res).id;
    expect(await audits(c, 'approval_rule')).toEqual([{ user_id: u.admin, user_email: null, action: 'create', entity_id: id,
      entity_ref: 'Big bills', changes: { fields: [
        field('name', null, 'Big bills'), field('document_type', null, 'supplier_invoice'), field('condition_field', null, 'total'),
        field('condition_operator', null, 'greater_equal'), field('condition_value', null, '1000.00'),
        field('approver_role', null, 'manager'), field('is_active', null, 'true'), field('priority', null, '100')],
      metadata: { actorRole: 'admin' } } }]);
  });

  it('create applies the same defaults: total, greater_than, 0, admin', async () => {
    const c = await company();
    const res = await rules(u.owner, c, 'POST', { name: 'd', documentType: 'manual_journal' });
    expect(dataOf(res)).toMatchObject({ conditionField: 'total', conditionOperator: 'greater_than', conditionValue: 0,
      approverRole: 'admin', isActive: true });
  });

  it('update: only the fields that moved; a toggle off by a rank above the rule', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'manager', { operator: 'greater_than', value: 500, name: 'm' });
    const res = await rules(u.admin, c, 'PUT', { id, isActive: false, name: ' m2 ' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf(res)).toMatchObject({ isActive: false, name: 'm2' });
    expect(await audits(c, 'approval_rule')).toEqual([{ user_id: u.admin, user_email: null, action: 'update', entity_id: id,
      entity_ref: 'm2', changes: { fields: [field('name', 'm', 'm2'), field('is_active', 'true', 'false')],
        metadata: { actorRole: 'admin' } } }]);
  });

  it('update with nothing that moves: an audit row with no fields, as before', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'manager', { name: 'same' });
    expect((await rules(u.owner, c, 'PUT', { id, name: 'same' })).state.statusCode).toBe(200);
    expect((await audits(c, 'approval_rule')).map((a) => a.changes)).toEqual([{ fields: [], metadata: { actorRole: 'owner' } }]);
  });

  it('delete: every audited field to null; a second delete is a 404; an unknown id is a 404', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'manager', { operator: 'any', name: 'gone' });
    expect((await rules(u.admin, c, 'DELETE', { id })).state.statusCode).toBe(200);
    const [row] = await audits(c, 'approval_rule');
    expect(row).toMatchObject({ action: 'delete', entity_id: id, entity_ref: 'gone' });
    expect(row.changes.fields).toEqual([
      field('name', 'gone', null), field('document_type', 'supplier_invoice', null), field('condition_field', 'amount', null),
      field('condition_operator', 'any', null), field('condition_value', '0.00', null), field('approver_role', 'manager', null),
      field('is_active', 'true', null), field('priority', '100', null)]);
    expect((await rules(u.admin, c, 'DELETE', { id })).state.statusCode).toBe(404);
    expect((await rules(u.admin, c, 'PUT', { id, name: 'x' })).state.statusCode).toBe(404);
  });

  it('a rule a request names: delete is still the in-use 400', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'manager');
    await pool.query(`INSERT INTO approval_requests(company_id, document_type, document_id, requested_by, rule_id)
      VALUES($1, 'supplier_invoice', gen_random_uuid(), $2, $3)`, [c, u.owner, id]);
    const res = await rules(u.admin, c, 'DELETE', { id });
    expect(res.state.statusCode).toBe(400);
    expect(await audits(c, 'approval_rule')).toEqual([]);
  });

  /** `statement` as app_user (owner, claims with an email) while audit rows of `entity` are refused: the error, or 'ok'. */
  async function withAuditRefused(c: string, entity: string, statement: string, params: unknown[]): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Refuse this company's audit rows of `entity` for the length of the transaction only.
      await client.query(`ALTER TABLE audit_log ADD CONSTRAINT n1b_no_audit
        CHECK (company_id <> '${c}'::UUID OR entity_type <> '${entity}') NOT VALID`);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.owner, session_id: crypto.randomUUID() })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [c]);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(statement, params);
      return 'ok';
    } catch (error) {
      return (error as { code?: string }).code ?? 'error';
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it.each([
    ['create', "SELECT * FROM approval_rule_create($1,$2,'x','supplier_invoice',NULL,'any',0,'owner') WHERE $3::UUID IS NOT NULL", 'approval_rule'],
    ['update', 'SELECT * FROM approval_rule_update($1,$3,$2,NULL,NULL,NULL,NULL,NULL,false)', 'approval_rule'],
    ['delete', 'SELECT * FROM approval_rule_delete($1,$3,$2)', 'approval_rule'],
    ['switch on', "SELECT * FROM approval_enforcement_set($1,'customer_invoice',true,$2) WHERE $3::UUID IS NOT NULL", 'approval_enforcement'],
    ['switch off', "SELECT * FROM approval_enforcement_set($1,'manual_journal',false,$2) WHERE $3::UUID IS NOT NULL", 'approval_enforcement'],
  ])('an audit row that cannot be written fails the %s: nothing changes unrecorded (blind L4)', async (_op, statement, entity) => {
    const c = await company();
    const rule = await plantRule(pool, c, 'manager', { name: 'kept' });
    await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1, 'manual_journal', $2)", [c, u.owner]);
    const before = (await pool.query(
      `SELECT (SELECT json_agg(r ORDER BY r.id) FROM approval_rules r WHERE r.company_id = $1) AS rules,
              (SELECT json_agg(e.document_type ORDER BY e.document_type) FROM approval_enforcement e WHERE e.company_id = $1) AS switches`,
      [c])).rows[0];
    expect(await withAuditRefused(c, entity, statement, [c, u.owner, rule])).toBe('23514');
    const after = (await pool.query(
      `SELECT (SELECT json_agg(r ORDER BY r.id) FROM approval_rules r WHERE r.company_id = $1) AS rules,
              (SELECT json_agg(e.document_type ORDER BY e.document_type) FROM approval_enforcement e WHERE e.company_id = $1) AS switches`,
      [c])).rows[0];
    expect(after).toEqual(before);
  });

  it("records the session's email as the actor's (the JWT claims' email, as withAuth's user.email) (adversarial REPRO 4)", async () => {
    const c = await company();
    await asRole(pool, 'app_user', c, { sub: u.owner }, async (cl) => {
      await cl.query("SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: u.owner, session_id: crypto.randomUUID(), email: 'owner@n1b.test' })]);
      await cl.query("SELECT * FROM approval_enforcement_set($1,'supplier_invoice',true,$2)", [c, u.owner]);
      await cl.query("SELECT * FROM approval_rule_create($1,$2,'e','supplier_invoice',NULL,'any',0,'manager')", [c, u.owner]);
    }, true);
    const { rows } = await pool.query('SELECT DISTINCT user_email FROM audit_log WHERE company_id = $1', [c]);
    expect(rows).toEqual([{ user_email: 'owner@n1b.test' }]);
  });

  it('the starter: every confirmed rule created and audited', async () => {
    const c = await company();
    const res = await rules(u.owner, c, 'POST', { action: 'starter', rules: [{ documentType: 'supplier_invoice' }, { documentType: 'manual_journal' }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ created: unknown[] }>(res).created).toHaveLength(2);
    expect((await audits(c, 'approval_rule')).map((a) => a.action)).toEqual(['create', 'create']);
  });
});

describe('the enforcement switch', () => {
  it('on then off, coupled payment types together, each row audited', async () => {
    const c = await company();
    expect((await enforcement(u.owner, c, { documentType: 'payment_batch', enabled: true })).state.statusCode).toBe(200);
    expect((await enforcement(u.owner, c, { documentType: 'payment_batch', enabled: true })).state.statusCode).toBe(200); // idempotent
    await plantRule(pool, c, 'admin', { documentType: 'supplier_payment' });
    expect((await enforcement(u.owner, c, { documentType: 'supplier_payment', enabled: false })).state.statusCode).toBe(200);
    const rows = await audits(c, 'approval_enforcement');
    expect(rows.map((a) => [a.action, a.entity_ref])).toEqual([
      ['create', 'supplier_payment'], ['create', 'payment_batch'], ['delete', 'supplier_payment'], ['delete', 'payment_batch']]);
    for (const a of rows) {
      expect(a.user_id).toBe(u.owner);
      expect(a.changes).toEqual({ fields: [], metadata: { actorRole: 'owner', enforcementId: a.entity_id,
        ...(a.action === 'delete' ? { strictestRuleRole: 'admin' } : {}) } });
    }
    expect((await pool.query('SELECT count(*)::INT AS n FROM approval_enforcement WHERE company_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('off with no active rule: no strictestRuleRole, and a manager may do it', async () => {
    const c = await company();
    await enforcement(u.owner, c, { documentType: 'customer_invoice', enabled: true });
    expect((await enforcement(u.manager, c, { documentType: 'customer_invoice', enabled: false })).state.statusCode).toBe(200);
    expect((await audits(c, 'approval_enforcement')).at(-1)?.changes.metadata).toEqual({ actorRole: 'manager',
      enforcementId: expect.any(String) });
  });
});
