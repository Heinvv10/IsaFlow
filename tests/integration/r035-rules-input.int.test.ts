/**
 * R-035 follow-up PR A, review round 1 (adversarial REPRO 1–3, blind LOW): the
 * rule write paths the new toggle and form drive must refuse a body value the
 * guards cannot judge, 400 before any write.
 *
 * `weakensRule` tests `isActive === false` and compares amounts numerically; pg
 * coerces 'false' / 0 to false and stores 'NaN' in numeric(15,2), where
 * `amount > NaN` never matches. So a string `isActive` deactivated an
 * admin-level rule an admin may not weaken, and conditionValue 'NaN' neutered
 * it — both past the R-048 guard. An amount the column cannot hold (≥ 1e13) was
 * a 500 carrying the raw pg message. Repros folded in from prA-adv-r1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import { checkApproval } from '../../src/modules/accounting/services/gl/approvalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, Object.values(u)));

const URL = '/api/accounting/approval-rules';
const call = (as: string, c: string, method: string, body: unknown) => callRoute(approvalRules, tokens[as]!, c, method, body, URL);
const company = () => newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin']], companies);
const ruleRow = async (id: string) => (await pool.query(
  'SELECT is_active, condition_value::TEXT AS v, approver_role FROM approval_rules WHERE id = $1', [id])).rows[0];
const ruleCount = async (c: string) => Number((await pool.query(
  'SELECT count(*) FROM approval_rules WHERE company_id = $1', [c])).rows[0].count);
const audits = async (c: string) => Number((await pool.query(
  `SELECT count(*) FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_rule'`, [c])).rows[0].count);
const messageOf = (res: { state: { body: unknown } }) => (res.state.body as { error?: { message?: string } }).error?.message ?? '';

describe('PUT isActive must be a real boolean (REPRO 1)', () => {
  it('control: an admin deactivating an admin-level rule with isActive=false is refused 403', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_than', value: 1000 });
    const res = await call(u.admin, c, 'PUT', { id, isActive: false });
    expect(res.state.statusCode).toBe(403);
    expect((await ruleRow(id)).is_active).toBe(true);
  });

  it.each([['the string "false"', 'false'], ['the string "no"', 'no'], ['0', 0], ['null', null]])(
    'isActive as %s: 400, the rule stays active, nothing audited', async (_label, isActive) => {
      const c = await company();
      const id = await plantRule(pool, c, 'admin', { operator: 'greater_than', value: 1000 });
      const res = await call(u.admin, c, 'PUT', { id, isActive });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(messageOf(res)).toBe('isActive must be true or false');
      expect((await ruleRow(id)).is_active).toBe(true);
      expect(await audits(c)).toBe(0);
    });
});

describe('conditionValue must be a number from 0 to 9 999 999 999 999.99 (REPRO 2, 3)', () => {
  const BAD: [string, unknown][] = [
    ['the string "NaN"', 'NaN'], ['a numeric string', '1000'], ['negative', -1], ['null', null],
    ['beyond numeric(15,2)', 1e13], ['an object', { v: 1 }],
    // Review round 2 (prA-adv-r2): more coercions, and sub-cent amounts numeric(15,2) would round.
    ['"Infinity"', 'Infinity'], ['" 100 "', ' 100 '], ['true', true], ['[100]', [100]],
    ['a sub-cent amount', 999.995], ['three decimals', 1000.001],
  ];

  it.each(BAD)('PUT %s: 400, the stored amount and the match are unchanged', async (_label, conditionValue) => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_than', value: 1000 });
    const res = await call(u.owner, c, 'PUT', { id, conditionValue });
    const check = await inRequest(pool, u.admin, c, () => checkApproval(c, 'supplier_invoice', crypto.randomUUID(), 50000));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toBe('conditionValue must be a number from 0 to 9999999999999.99 with at most 2 decimals');
    expect((await ruleRow(id)).v).toBe('1000.00');
    expect(check.matchedRule?.id).toBe(id);
    expect(await audits(c)).toBe(0);
  });

  it.each(BAD)('POST %s: 400, nothing created, no pg text in the body', async (_label, conditionValue) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', {
      name: 'Bad amount', documentType: 'supplier_invoice', conditionOperator: 'greater_than', conditionValue, approverRole: 'admin',
    });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toMatch(/numeric|overflow/i);
    expect(await ruleCount(c)).toBe(0);
  });

  it('the largest amount the column holds is accepted on POST and PUT', async () => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', {
      name: 'Top', documentType: 'supplier_invoice', conditionOperator: 'greater_than', conditionValue: 9999999999999.99, approverRole: 'admin',
    });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const id = (res.state.body as { data: { id: string } }).data.id;
    expect((await ruleRow(id)).v).toBe('9999999999999.99');
    const put = await call(u.owner, c, 'PUT', { id, conditionValue: 9999999999999 });
    expect(put.state.statusCode, JSON.stringify(put.state.body)).toBe(200);
  });

  it('starter (REPRO 3): an amount beyond the column on row 2 is a 400 before any write, row 1 not created', async () => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { action: 'starter', rules: [
      { documentType: 'manual_journal' }, { documentType: 'supplier_invoice', conditionValue: 1e13 },
    ] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(JSON.stringify(res.state.body)).not.toMatch(/numeric|overflow/i);
    expect(await ruleCount(c)).toBe(0);
  });

  it('the starter ignores a smuggled companyId / name / operator in a row (adversarial probe)', async () => {
    const c = await company();
    const other = await company();
    const res = await call(u.owner, c, 'POST', { action: 'starter', companyId: other, rules: [
      { documentType: 'supplier_invoice', companyId: other, name: 'x', conditionOperator: 'any', approverRole: 'manager' },
    ] });
    expect(res.state.statusCode).toBe(200);
    expect(await ruleCount(other)).toBe(0);
    expect((await pool.query('SELECT condition_operator, name FROM approval_rules WHERE company_id = $1', [c])).rows)
      .toEqual([{ condition_operator: 'greater_than', name: 'Large supplier invoices' }]);
  });
});

describe('review round 2 (prA-adv-r2)', () => {
  it('REPRO A: "≥ R1 000" cannot become "> R1 000.00" via conditionValue 999.995 (rounded past the R-048 guard)', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_equal', value: 1000 });
    const res = await call(u.admin, c, 'PUT', { id, conditionOperator: 'greater_than', conditionValue: 999.995 });
    const atThreshold = await inRequest(pool, u.admin, c, () => checkApproval(c, 'supplier_invoice', crypto.randomUUID(), 1000));
    expect(res.state.statusCode).toBe(400);
    expect((await pool.query('SELECT condition_operator, condition_value::TEXT AS v FROM approval_rules WHERE id = $1', [id])).rows[0])
      .toEqual({ condition_operator: 'greater_equal', v: '1000.00' });
    expect(atThreshold.matchedRule?.id).toBe(id);
  });

  it('control: the same change written exactly ("> 1000") is refused 403', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_equal', value: 1000 });
    expect((await call(u.admin, c, 'PUT', { id, conditionOperator: 'greater_than', conditionValue: 1000 })).state.statusCode).toBe(403);
  });

  it('a starter amount with more than 2 decimals is a 400, nothing created', async () => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', { action: 'starter', rules: [{ documentType: 'supplier_invoice', conditionValue: 50000.005 }] });
    expect(res.state.statusCode).toBe(400);
    expect(await ruleCount(c)).toBe(0);
  });

  // Census (report): every documentType rule matching is called with is one of
  // RULE_FORM_DOCUMENT_TYPES or a legacy type; legacy types keep their own 400.
  it.each([['["supplier_invoice"]', ['supplier_invoice']], ['"Supplier_Invoice"', 'Supplier_Invoice'],
    ['"purchase_order"', 'purchase_order'], ['5', 5]] as [string, unknown][])(
    'REPRO B: POST documentType %s: 400, nothing created', async (_l, documentType) => {
      const c = await company();
      const res = await call(u.owner, c, 'POST', {
        name: 'Adv', documentType, conditionOperator: 'greater_than', conditionValue: 10, approverRole: 'admin' });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(messageOf(res)).toMatch(/^documentType must be one of: supplier_invoice, /);
      expect(await ruleCount(c)).toBe(0);
    });

  const BAD_NAMES: [string, unknown][] = [['["x"]', ['x']], ['{"a":1}', { a: 1 }], ['12', 12], ['"   "', '   '],
    ['101 characters (audit_log.entity_ref is VARCHAR(100))', 'x'.repeat(101)]];

  it.each(BAD_NAMES)('REPRO B2: POST name %s: 400, nothing created', async (_l, name) => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', {
      name, documentType: 'supplier_invoice', conditionOperator: 'greater_than', conditionValue: 10, approverRole: 'admin' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await ruleCount(c)).toBe(0);
  });

  it.each([...BAD_NAMES, ['empty', '']] as [string, unknown][])('PUT name %s: 400, the name unchanged', async (_l, name) => {
    const c = await company();
    const id = await plantRule(pool, c, 'admin', { operator: 'greater_than', value: 1000, name: 'Keep me' });
    const res = await call(u.owner, c, 'PUT', { id, name });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toBe('name must be text of 1 to 100 characters');
    expect((await pool.query('SELECT name FROM approval_rules WHERE id = $1', [id])).rows[0].name).toBe('Keep me');
  });

  it('a name is stored trimmed; 100 characters is accepted', async () => {
    const c = await company();
    const res = await call(u.owner, c, 'POST', {
      name: '  Big bills  ', documentType: 'supplier_invoice', conditionOperator: 'any', approverRole: 'admin' });
    expect(res.state.statusCode).toBe(200);
    const id = (res.state.body as { data: { id: string } }).data.id;
    expect((await pool.query('SELECT name FROM approval_rules WHERE id = $1', [id])).rows[0].name).toBe('Big bills');
    expect((await call(u.owner, c, 'PUT', { id, name: 'y'.repeat(100) })).state.statusCode).toBe(200);
  });
});
