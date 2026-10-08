/**
 * R-035 follow-up, PR A (goal §3): "Start from recommended rules" through the
 * real route, on real Postgres.
 *
 * POST /api/accounting/approval-rules { action: 'starter', rules: [...] } creates
 * the confirmed subset of STARTER_RULES as the company's OWN rules, every one
 * through createRule (assertMayDemand, the legacy refusal, the audit), in ONE
 * savepoint: all are created or none. A rule whose (document_type, name) is
 * already ACTIVE for the company is skipped and reported. The body is
 * typeof-validated before any write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import { STARTER_RULES } from '../../src/modules/accounting/services/gl/approvalStarterRules';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, reasonOf } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', manager: '', ownerB: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, Object.values(u)));

const URL = '/api/accounting/approval-rules';
const post = (as: string, company: string, body: unknown) => callRoute(approvalRules, tokens[as]!, company, 'POST', body, URL);
const starter = (as: string, company: string, rules: unknown) => post(as, company, { action: 'starter', rules });
const ALL = STARTER_RULES.map((r) => ({ documentType: r.documentType }));
const company = () => newCompany(pool, [[u.owner, 'owner'], [u.manager, 'manager']], companies);

type Row = { company_id: string; document_type: string; name: string; condition_operator: string;
  condition_value: number; approver_role: string; is_active: boolean };
const rulesOf = async (c: string): Promise<Row[]> => (await pool.query(
  `SELECT company_id, document_type, name, condition_operator, condition_value::FLOAT AS condition_value, approver_role, is_active
   FROM approval_rules WHERE company_id = $1 ORDER BY document_type COLLATE "C", created_at`, [c])).rows;
const audits = async (c: string) => (await pool.query(
  `SELECT action, user_id, entity_id, entity_ref FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_rule'`, [c])).rows;
const dataOf = (res: { state: { body: unknown } }) =>
  (res.state.body as { data: { created: { id: string; documentType: string; name: string }[];
    skipped: { documentType: string; name: string }[] } }).data;
const messageOf = (res: { state: { body: unknown } }) => (res.state.body as { error?: { message?: string } }).error?.message;
const asRow = (c: string, r: (typeof STARTER_RULES)[number]) => ({
  company_id: c, document_type: r.documentType, name: r.name, condition_operator: r.conditionOperator,
  condition_value: r.conditionValue, approver_role: r.approverRole, is_active: true,
});
const byType = (rows: Row[]) => [...rows].sort((a, b) => (a.document_type < b.document_type ? -1 : 1));

describe('the confirmed starter set', () => {
  it('creates exactly the seven recommended rules for this company, each audited as a create by the actor', async () => {
    const c = await company();
    const res = await starter(u.owner, c, ALL);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf(res).created).toHaveLength(7);
    expect(dataOf(res).skipped).toEqual([]);
    expect(await rulesOf(c)).toEqual(byType(STARTER_RULES.map((r) => asRow(c, r))));
    const rows = await audits(c);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((a) => a.entity_id))).toEqual(new Set(dataOf(res).created.map((r) => r.id)));
    for (const a of rows) expect(a).toMatchObject({ action: 'create', user_id: u.owner });
  });

  it('creates only the ticked rows, with the amount and approver the person changed', async () => {
    const c = await company();
    const res = await starter(u.owner, c, [
      { documentType: 'supplier_invoice', conditionValue: 75000, approverRole: 'admin' },
      { documentType: 'manual_journal' },
    ]);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await rulesOf(c)).toEqual([
      { ...asRow(c, STARTER_RULES[6]!) },
      { ...asRow(c, STARTER_RULES[0]!), condition_value: 75000, approver_role: 'admin' },
    ]);
    expect(await audits(c)).toHaveLength(2);
  });
});

describe('idempotent on the active (document_type, name)', () => {
  it('a second confirm creates nothing and reports all seven skipped', async () => {
    const c = await company();
    expect((await starter(u.owner, c, ALL)).state.statusCode).toBe(200);
    const again = await starter(u.owner, c, ALL);
    expect(again.state.statusCode).toBe(200);
    expect(dataOf(again).created).toEqual([]);
    expect(dataOf(again).skipped).toEqual(STARTER_RULES.map((r) => ({ documentType: r.documentType, name: r.name })));
    expect(await rulesOf(c)).toHaveLength(7);
    expect(await audits(c)).toHaveLength(7);
  });

  it('the same name on ANOTHER type does not count, and neither does an inactive rule', async () => {
    const c = await company();
    // Both credit-note rules are named "Credit notes over R10k".
    expect((await starter(u.owner, c, [{ documentType: 'customer_credit_note' }, { documentType: 'supplier_invoice' }]))
      .state.statusCode).toBe(200);
    await pool.query(`UPDATE approval_rules SET is_active = false WHERE company_id = $1 AND document_type = 'supplier_invoice'`, [c]);
    const res = await starter(u.owner, c, [
      { documentType: 'customer_credit_note' }, { documentType: 'supplier_credit_note' }, { documentType: 'supplier_invoice' },
    ]);
    expect(res.state.statusCode).toBe(200);
    expect(dataOf(res).skipped).toEqual([{ documentType: 'customer_credit_note', name: 'Credit notes over R10k' }]);
    expect(dataOf(res).created.map((r) => r.documentType)).toEqual(['supplier_credit_note', 'supplier_invoice']);
    expect((await rulesOf(c)).map((r) => [r.document_type, r.is_active])).toEqual([
      ['customer_credit_note', true], ['supplier_credit_note', true], ['supplier_invoice', false], ['supplier_invoice', true],
    ]);
  });
});

describe('all or nothing', () => {
  it('a manager confirming an admin-level payment rule after a manager-level one: 403 verbatim, NOTHING created or audited', async () => {
    const c = await company();
    const res = await starter(u.manager, c, [{ documentType: 'supplier_invoice' }, { documentType: 'supplier_payment' }]);
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    expect(messageOf(res)).toBe('This rule requires the admin role; you do not hold it, so you cannot create, change or delete it');
    expect(await rulesOf(c)).toEqual([]);
    expect(await audits(c)).toEqual([]);
  });

  it('an override above the actor is refused the same way', async () => {
    const c = await company();
    const res = await starter(u.manager, c, [{ documentType: 'manual_journal' }, { documentType: 'customer_invoice', approverRole: 'owner' }]);
    expect(res.state.statusCode).toBe(403);
    expect(await rulesOf(c)).toEqual([]);
    expect(await audits(c)).toEqual([]);
  });

  it('the same manager may lower that row to their own rank, and it is created', async () => {
    const c = await company();
    const res = await starter(u.manager, c, [{ documentType: 'supplier_invoice' }, { documentType: 'supplier_payment', approverRole: 'manager' }]);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await rulesOf(c)).map((r) => [r.document_type, r.approver_role])).toEqual([
      ['supplier_invoice', 'manager'], ['supplier_payment', 'manager'],
    ]);
  });
});

describe('legacy types are refused', () => {
  it.each(['credit_note', 'payment', 'journal_entry'])('a new %s rule: 400 naming the type to use, nothing created', async (documentType) => {
    const c = await company();
    const res = await post(u.owner, c, { name: 'Legacy', documentType, conditionOperator: 'any', approverRole: 'manager' });
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/no longer govern/);
    const viaStarter = await starter(u.owner, c, [{ documentType: 'supplier_invoice' }, { documentType }]);
    expect(viaStarter.state.statusCode).toBe(400);
    expect(await rulesOf(c)).toEqual([]);
    expect(await audits(c)).toEqual([]);
  });
});

describe('the body is validated before any write', () => {
  it.each([
    ['no rules', undefined],
    ['rules not a list', { documentType: 'supplier_invoice' }],
    ['an empty list', []],
    ['a row that is not an object', ['supplier_invoice']],
    ['a type outside the set', [{ documentType: 'purchase_order' }]],
    ['a type twice', [{ documentType: 'manual_journal' }, { documentType: 'manual_journal' }]],
    ['an amount as text', [{ documentType: 'supplier_invoice', conditionValue: '75000' }]],
    ['a negative amount', [{ documentType: 'supplier_invoice', conditionValue: -1 }]],
    ['an amount on a rule that matches every journal', [{ documentType: 'manual_journal', conditionValue: 5 }]],
    ['a role the ladder does not know', [{ documentType: 'supplier_invoice', approverRole: 'Owner' }]],
    ['a role that is not text', [{ documentType: 'supplier_invoice', approverRole: 5 }]],
  ])('%s: 400, nothing created', async (_label, rules) => {
    const c = await company();
    const res = await starter(u.owner, c, rules);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await rulesOf(c)).toEqual([]);
    expect(await audits(c)).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it("company B's starter is not skipped by A's rules, and neither company lists the other's", async () => {
    const a = await company();
    const b = await newCompany(pool, [[u.ownerB, 'owner']], companies);
    expect((await starter(u.owner, a, ALL)).state.statusCode).toBe(200);
    const listB = await callRoute(approvalRules, tokens[u.ownerB]!, b, 'GET', undefined, URL);
    expect((listB.state.body as { data: { items: unknown[] } }).data.items).toEqual([]);

    const resB = await starter(u.ownerB, b, ALL);
    expect(dataOf(resB).created).toHaveLength(7);
    expect(dataOf(resB).skipped).toEqual([]);
    expect((await rulesOf(a)).every((r) => r.company_id === a)).toBe(true);
    expect((await rulesOf(b)).every((r) => r.company_id === b)).toBe(true);
    expect(await audits(b)).toHaveLength(7);
    expect(await audits(a)).toHaveLength(7);

    const listA = await callRoute(approvalRules, tokens[u.owner]!, a, 'GET', undefined, URL);
    const idsA = (listA.state.body as { data: { items: { id: string }[] } }).data.items.map((r) => r.id);
    expect(idsA).toHaveLength(7);
    expect(idsA).not.toContain(dataOf(resB).created[0]!.id);
  });
});
