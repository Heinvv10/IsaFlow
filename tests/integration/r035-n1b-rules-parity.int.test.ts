/**
 * R-035 N1b (B, migration 881): the SQL definers refuse exactly what the
 * TypeScript refuses — no change to who may create, edit or switch what.
 *
 * Per refusal class, the same input goes (a) through the real route, where the
 * TypeScript check answers first, and (b) straight to the definer as app_user
 * under the same user's claims, past every TypeScript check. Both refuse; the
 * SQL refusal carries its own SQLSTATE and the route's exact message, and
 * maps back (ruleRefusal) onto the TypeScript error the route answered with.
 * The predicates themselves are then compared value by value: names, amounts,
 * trim, mayDemandRole, mayWeakenAtLevel and weakensRule against their SQL twins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { ruleRefusal } from '../../src/modules/accounting/services/gl/approvalRuleRefusals';
import { isRuleAmount, isRuleName } from '../../src/modules/accounting/services/gl/approvalRuleOptions';
import { mayWeakenAtLevel, weakensRule, type RuleChange } from '../../src/modules/accounting/services/gl/approvalRuleGuards';
import { APPROVER_ROLES, mayDemandRole } from '../../src/modules/accounting/services/gl/approvalRank';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule } from './r035-approval.helpers';
import { impersonationToken, messageOf } from './r035-pr2.helpers';
import { asRole } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', admin: '', manager: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [Object.values(u)]);
  await cleanup(pool, companies, Object.values(u));
});

const company = () => newCompany(pool, [[u.owner, 'owner'], [u.admin, 'admin'], [u.manager, 'manager']], companies);
const rules = (as: string, c: string, method: string, body: unknown, token = tokens[as]!) =>
  callRoute(approvalRules, token, c, method, body, '/api/accounting/approval-rules');
const enforcement = (as: string, c: string, body: unknown, token = tokens[as]!) =>
  callRoute(approvalEnforcement, token, c, 'POST', body, '/api/accounting/approval-enforcement');

/** The definer's error (code, message, detail) as `sub`, past every TypeScript check. */
async function sqlError(c: string, sub: string, text: string, params: unknown[], sessionId?: string) {
  try {
    await asRole(pool, 'app_user', c, { sub, sessionId }, (cl) => cl.query(text, params));
  } catch (error) {
    return error as { code: string; message: string; detail?: string };
  }
  throw new Error('the definer accepted it');
}

const CREATE = 'SELECT * FROM approval_rule_create($1,$2,$3,$4,$5,$6,$7,$8)';
const UPDATE = 'SELECT * FROM approval_rule_update($1,$2,$3,$4,$5,$6,$7,$8,$9)';
const DELETE = 'SELECT * FROM approval_rule_delete($1,$2,$3)';
const SWITCH = 'SELECT * FROM approval_enforcement_set($1,$2,$3,$4)';

type Body = Record<string, unknown>;
const createArgs = (c: string, actor: string, b: Body) => [c, actor, b.name ?? null, b.documentType ?? null,
  b.conditionField ?? null, b.conditionOperator ?? null, b.conditionValue ?? null, b.approverRole ?? null];

describe('per refusal class, the route and the definer refuse alike', () => {
  it.each([
    ['RB003 a legacy type', { name: 'r', documentType: 'credit_note' }, 400],
    ['RB004 a type no rule governs', { name: 'r', documentType: 'Supplier_Invoice' }, 400],
    ['RB005 a blank name', { name: ' ​ ', documentType: 'supplier_invoice' }, 400],
    ['RB005 a name over 100 characters', { name: 'x'.repeat(101), documentType: 'supplier_invoice' }, 400],
    ['RB006 an approver role off the ladder', { name: 'r', documentType: 'supplier_invoice', approverRole: 'Owner' }, 400],
    ['RB007 an operator nothing evaluates', { name: 'r', documentType: 'supplier_invoice', conditionOperator: 'gt' }, 400],
    ['RB008 a field nothing evaluates', { name: 'r', documentType: 'supplier_invoice', conditionField: 'vat' }, 400],
    ['RB009 a sub-cent amount', { name: 'r', documentType: 'supplier_invoice', conditionValue: 0.005 }, 400],
    ['RB009 an amount the column cannot hold', { name: 'r', documentType: 'supplier_invoice', conditionValue: 1e13 }, 400],
    ['RB009 a negative amount', { name: 'r', documentType: 'supplier_invoice', conditionValue: -1 }, 400],
    ['RB001 creating a rule above one\'s rank', { name: 'r', documentType: 'supplier_invoice', approverRole: 'owner' }, 403],
  ])('create: %s', async (label, body, status) => {
    const c = await company();
    const route = await rules(u.admin, c, 'POST', body);
    expect(route.state.statusCode, JSON.stringify(route.state.body)).toBe(status);
    const err = await sqlError(c, u.admin, CREATE, createArgs(c, u.admin, body));
    expect(err.code).toBe(label.slice(0, 5));
    expect(err.message).toBe(messageOf(route));
    expect(ruleRefusal(err)?.message).toBe(messageOf(route));
  });

  it.each([
    ['RB001 an edit of a rule above one\'s rank', 'owner', { name: 'renamed' }, u => u.admin],
    ['RB002 deactivating a rule at one\'s own rank', 'admin', { isActive: false }, u => u.admin],
    ['RB002 lowering a rule at one\'s own rank', 'admin', { approverRole: 'manager' }, u => u.admin],
    ['RB002 narrowing a rule at one\'s own rank', 'admin', { conditionOperator: 'greater_than', conditionValue: 5000 }, u => u.admin],
    ['RB001 raising a rule above one\'s rank', 'manager', { approverRole: 'owner' }, u => u.admin],
  ] as [string, string, Body, (x: typeof u) => string][])('update: %s', async (label, ruleRole, body, who) => {
    const c = await company();
    const id = await plantRule(pool, c, ruleRole, { operator: 'greater_than', value: 1000 });
    const actor = who(u);
    const route = await rules(actor, c, 'PUT', { id, ...body });
    expect(route.state.statusCode, JSON.stringify(route.state.body)).toBe(403);
    const err = await sqlError(c, actor, UPDATE, [c, id, actor, body.name ?? null, null, body.conditionOperator ?? null,
      body.conditionValue ?? null, body.approverRole ?? null, body.isActive ?? null]);
    expect(err.code).toBe(label.slice(0, 5));
    expect(err.message).toBe(messageOf(route));
    expect(ruleRefusal(err)?.message).toBe(messageOf(route));
  });

  it.each([['RB001', 'owner'], ['RB002', 'admin']])('delete: %s', async (code, ruleRole) => {
    const c = await company();
    const id = await plantRule(pool, c, ruleRole);
    const route = await rules(u.admin, c, 'DELETE', { id });
    expect(route.state.statusCode).toBe(403);
    const err = await sqlError(c, u.admin, DELETE, [c, id, u.admin]);
    expect(err.code).toBe(code);
    expect(err.message).toBe(messageOf(route));
  });

  it('RB010 switching on a type no gate reads', async () => {
    const c = await company();
    const route = await enforcement(u.owner, c, { documentType: 'payment', enabled: true });
    expect(route.state.statusCode).toBe(400);
    const err = await sqlError(c, u.owner, SWITCH, [c, 'payment', true, u.owner]);
    expect([err.code, err.message]).toEqual(['RB010', messageOf(route)]);
  });

  it.each([['supplier_invoice', 'admin'], ['payment_batch', 'admin'], ['supplier_payment', 'owner']])(
    'RB011 switching %s off under an active %s rule one may not weaken', async (type, ruleRole) => {
      const c = await company();
      // The coupled pair: a rule on EITHER payment type governs switching off both.
      await plantRule(pool, c, ruleRole, { documentType: type === 'payment_batch' ? 'supplier_payment' : type });
      await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) SELECT $1, t, $2 FROM unnest($3::text[]) t",
        [c, u.owner, type === 'supplier_invoice' ? [type] : ['supplier_payment', 'payment_batch']]);
      const route = await enforcement(u.admin, c, { documentType: type, enabled: false });
      expect(route.state.statusCode).toBe(403);
      const err = await sqlError(c, u.admin, SWITCH, [c, type, false, u.admin]);
      expect([err.code, err.message]).toEqual(['RB011', messageOf(route)]);
    });

  it('RB012 the bank control from a "Login as" session', async () => {
    const c = await company();
    const token = await impersonationToken(pool, u.owner, u.admin);
    const route = await enforcement(u.owner, c, { documentType: 'supplier_bank_details', enabled: true }, token);
    expect(route.state.statusCode).toBe(403);
    const sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO impersonation_sessions(session_id, actor_user_id, target_user_id) VALUES($1,$2,$3)',
      [sessionId, u.admin, u.owner]);
    const err = await sqlError(c, u.owner, SWITCH, [c, 'supplier_bank_details', true, u.owner], sessionId);
    expect([err.code, err.message]).toEqual(['RB012', messageOf(route)]);
  });

  it('RB013 the bank control switched on below the verifier role', async () => {
    const c = await company();
    const route = await enforcement(u.manager, c, { documentType: 'supplier_bank_details', enabled: true });
    expect(route.state.statusCode).toBe(403);
    const err = await sqlError(c, u.manager, SWITCH, [c, 'supplier_bank_details', true, u.manager]);
    expect([err.code, err.message]).toEqual(['RB013', messageOf(route)]);
  });
});

describe('the predicates, value by value', () => {
  const sqlBool = async (text: string, params: unknown[]) => (await pool.query(text, params)).rows[0].ok as boolean;

  it.each([
    'r', '  padded  ', 'x'.repeat(100), 'x'.repeat(101), '😀'.repeat(50), '😀'.repeat(51), '', '   ', '\t\n',
    '  ', 'a\u0007b', '​', '​⁠', '́', '️', 'ㅤ', '⠀', 'Large bills — owner',
    '­', 'ok​', 'résumé',
  ])('isRuleName(%j) = approval_rule_name_ok', async (name) => {
    expect(await sqlBool('SELECT approval_rule_name_ok($1) AS ok', [name])).toBe(isRuleName(name));
  });

  it('LIMIT, named: a name of only a rarer combining mark (U+0591) is refused by TypeScript, passed by SQL', async () => {
    expect(isRuleName('֑')).toBe(false);
    expect(await sqlBool('SELECT approval_rule_name_ok($1) AS ok', ['֑'])).toBe(true);
  });

  it.each(['  a  ', ' a　', '﻿a ', '\t\na b\r\n'])('trim(%j) = approval_rule_js_trim', async (s) => {
    expect((await pool.query('SELECT approval_rule_js_trim($1) AS t', [s])).rows[0].t).toBe(s.trim());
  });

  it.each([0, 0.01, 1000, 999.99, 9_999_999_999_999.99, 1e13, -0.01, 0.005, 0.1 + 0.2, 123.456])(
    'isRuleAmount(%s) = approval_rule_amount_ok', async (v) => {
      expect(await sqlBool('SELECT approval_rule_amount_ok($1::NUMERIC) AS ok', [v])).toBe(isRuleAmount(v));
    });

  it('mayDemandRole and mayWeakenAtLevel, every actor role × rule role (and unknown ones)', async () => {
    const roles = [...APPROVER_ROLES, 'Owner', 'nobody'];
    for (const actor of roles) {
      for (const rule of roles) {
        const { rows: [x] } = await pool.query(
          `SELECT approval_rule_may_weaken($1, $2) AS weaken,
                  approval_actor_rank($1) >= approval_required_rank($2) AS demand`, [actor, rule]);
        expect([actor, rule, x.weaken, x.demand]).toEqual([actor, rule, mayWeakenAtLevel(actor, rule), mayDemandRole(actor, rule)]);
      }
    }
  });

  it('weakensRule = approval_rule_weakens over a matrix of rules and changes', async () => {
    const befores = [
      { approver_role: 'admin', condition_operator: 'greater_than', condition_value: '1000.00', is_active: true },
      { approver_role: 'owner', condition_operator: 'greater_equal', condition_value: '1000.00', is_active: true },
      { approver_role: null, condition_operator: 'any', condition_value: '0.00', is_active: false },
      { approver_role: 'Owner', condition_operator: 'gt', condition_value: null, is_active: true },
    ];
    const changes: RuleChange[] = ['delete', {}, { approverRole: 'manager' }, { approverRole: 'owner' }, { approverRole: 'nobody' },
      { isActive: false }, { isActive: true }, { conditionOperator: 'any' }, { conditionOperator: 'greater_than' },
      { conditionOperator: 'greater_equal' }, { conditionValue: 999.99 }, { conditionValue: 1000 }, { conditionValue: 1000.01 },
      { conditionOperator: 'greater_than', conditionValue: 0 }, { conditionOperator: 'greater_equal', conditionValue: 0 }];
    for (const before of befores) {
      for (const change of changes) {
        const c = change === 'delete' ? {} : change;
        const { rows: [x] } = await pool.query(
          `SELECT approval_rule_weakens(ROW(gen_random_uuid(), 'n', 'supplier_invoice', 'total', $1, $2::NUMERIC, $3, $4,
                    100, now(), now(), NULL)::approval_rules, $5, $6, $7, $8, $9::NUMERIC) AS ok`,
          [before.condition_operator, before.condition_value, before.approver_role, before.is_active, change === 'delete',
            c.approverRole ?? null, c.isActive ?? null, c.conditionOperator ?? null, c.conditionValue ?? null]);
        expect([before, change, x.ok]).toEqual([before, change, weakensRule(before, change)]);
      }
    }
  });
});
