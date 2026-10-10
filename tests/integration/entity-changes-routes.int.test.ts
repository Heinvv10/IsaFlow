/**
 * Forensic-controls step 3 — the history as people and agents reach it:
 *  - writes through the real routes, MCP and the SECURITY DEFINER writers
 *    (approval rules and switches, 881/885) are recorded with the person;
 *  - GET /api/accounting/entity-changes: a timeline for whoever may read the
 *    type, the company-wide feed for owner / admin, bank numbers masked;
 *  - POST /api/accounting/entity-changes-reveal: owner / admin in their own
 *    session, audited; Login-as refused;
 *  - MCP entity_history: masked, the same reading rules, read:payroll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import entityChanges from '../../pages/api/accounting/entity-changes';
import entityChangesReveal from '../../pages/api/accounting/entity-changes-reveal';
import suppliersList from '../../pages/api/accounting/suppliers-list';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import companyUsers from '../../pages/api/accounting/company-users';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { mcpCall } from './entity-changes-mcp.helpers';
import type { EntityChangePage, EntityChangeView } from '../../src/modules/accounting/services/core/entityChanges/entityChangeTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '';

beforeAll(async () => { [o, a, m, v] = await members(pool, tokens, 4); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [[o, a, m, v]]);
  await cleanupEntityChanges(pool, companies, [o, a, m, v]);
});

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer']], companies);
const get = (user: string, c: string, query: Record<string, string>, token = tokens[user]!) =>
  callRoute(entityChanges, token, c, 'GET', undefined, '/api/accounting/entity-changes', query);
const page = async (user: string, c: string, query: Record<string, string>) => {
  const res = await get(user, c, query);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<EntityChangePage>(res);
};
const reveal = (user: string, c: string, changeId: string, token = tokens[user]!) =>
  callRoute(entityChangesReveal, token, c, 'POST', { changeId }, '/api/accounting/entity-changes-reveal');
const field = (c: EntityChangeView, key: string) => c.fields.find((f) => f.key === key);

async function supplierViaRoute(c: string): Promise<string> {
  const res = await callRoute(suppliersList, tokens[a]!, c, 'POST',
    { name: 'ECR supplier', bank_account_number: '1234567890', bank_branch_code: '250655' }, '/api/accounting/suppliers-list');
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBeLessThan(300);
  return String((dataOf<{ id: string } | { id: string }[]>(res) as { id?: string }).id
    ?? (dataOf<{ id: string }[]>(res))[0]!.id);
}

describe('a supplier timeline', () => {
  it('route and MCP writes are recorded with the person and channel; any member reads them masked', async () => {
    const c = await company();
    const s = await supplierViaRoute(c);
    const out = await mcpCall(pool, a, c, 'admin', 'update_supplier', { supplier_id: s, bank_account_number: '5555444433' });
    expect(out.isError, out.content[0]!.text).toBeFalsy();
    const { items } = await page(v, c, { entityType: 'supplier', entityId: s });
    expect(items.map((i) => [i.op, i.channel, i.actor])).toEqual([['update', 'token', a], ['create', 'session', a]]);
    expect(field(items[0]!, 'bank_account_number')).toEqual({ key: 'bank_account_number', before: '…7890', after: '…4433', masked: true });
    expect(field(items[1]!, 'bank_branch_code')).toMatchObject({ after: '250655', masked: false });
    expect(items[1]!.entityLabel).toBe('ECR supplier');
    expect(items[1]!.actorName).toBe(`${a}@test.local`);
    expect(JSON.stringify(items)).not.toContain('5555444433');
  });

  it('pages newest first by cursor', async () => {
    const c = await company();
    const s = await supplierViaRoute(c);
    for (const email of ['p1@x.test', 'p2@x.test']) await pool.query('UPDATE suppliers SET email = $2 WHERE id = $1', [s, email]);
    const first = await page(a, c, { entityType: 'supplier', entityId: s, limit: '2' });
    expect(first.items.map((i) => field(i, 'email')?.after)).toEqual(['p2@x.test', 'p1@x.test']);
    const rest = await page(a, c, { entityType: 'supplier', entityId: s, limit: '2', before: first.nextCursor! });
    expect(rest.items.map((i) => i.op)).toEqual(['create']);
    expect(rest.nextCursor).toBeNull();
  });
});

describe('who reads what', () => {
  it('the feed is owner / admin only; employee timelines need manager or above', async () => {
    const c = await company();
    const emp = (await pool.query(`INSERT INTO payroll_employees(company_id, employee_number, first_name, last_name, id_number,
      employment_type, start_date) VALUES($1,'R1','Ree','Oute','8001015009087','permanent','2026-01-01') RETURNING id`, [c])).rows[0].id;
    for (const user of [v, m]) expect((await get(user, c, {})).state.statusCode).toBe(403);
    const feed = await page(a, c, {});
    expect(new Set(feed.items.map((i) => i.entityType))).toEqual(new Set(['company', 'company_user', 'payroll_employee']));
    expect((await get(v, c, { entityType: 'payroll_employee', entityId: emp })).state.statusCode).toBe(403);
    const t = await page(m, c, { entityType: 'payroll_employee', entityId: emp });
    expect(field(t.items[0]!, 'id_number')).toMatchObject({ after: '…9087', masked: true });
    expect((await get(m, c, { entityType: 'company_user', entityId: emp })).state.statusCode).toBe(403);
    expect((await get(a, c, { entityId: emp })).state.statusCode).toBe(400);
  });

  it('MCP entity_history: masked, the same rules, employees need read:payroll', async () => {
    const c = await company();
    const s = await supplierViaRoute(c);
    const read = async (role: string, args: Record<string, unknown>, scopes = ['read:reports']) =>
      mcpCall(pool, role === 'viewer' ? v : a, c, role, 'entity_history', args, scopes);
    const ok = await read('viewer', { entity_type: 'supplier', entity_id: s });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse(ok.content[0]!.text) as { items: { fields: { key: string; after: unknown }[] }[] };
    expect(body.items[0]!.fields.find((f) => f.key === 'bank_account_number')!.after).toBe('…7890');
    expect(ok.content[0]!.text).not.toContain('1234567890');
    expect((await read('viewer', {})).isError).toBe(true);
    const emp = (await pool.query(`INSERT INTO payroll_employees(company_id, employee_number, first_name, last_name, employment_type,
      start_date) VALUES($1,'M1','Mc','Pee','permanent','2026-01-01') RETURNING id`, [c])).rows[0].id;
    expect((await read('admin', { entity_type: 'payroll_employee', entity_id: emp })).isError).toBe(true);
    // Nor the feed filtered to employees (security review of f0d905b8).
    const filtered = await read('admin', { entity_type: 'payroll_employee' });
    expect(filtered.isError).toBe(true);
    expect(filtered.content[0]!.text).toContain('read:payroll');
    expect((await read('admin', { entity_type: 'payroll_employee', entity_id: emp }, ['read:reports', 'read:payroll'])).isError).toBeFalsy();
    const feed = JSON.parse((await read('admin', {})).content[0]!.text) as { items: { entity_type: string }[] };
    expect(feed.items.some((i) => i.entity_type === 'payroll_employee')).toBe(false);
  });
});

describe('definer-written entities record the person, not the definer', () => {
  it('approval rules (881) and switches (885) through their routes; a member role change', async () => {
    const c = await company();
    const rule = await callRoute(approvalRules, tokens[a]!, c, 'POST', { name: 'ECR rule', documentType: 'supplier_invoice',
      conditionField: 'amount', conditionOperator: 'any', conditionValue: 0, approverRole: 'admin' }, '/api/accounting/approval-rules');
    expect(rule.state.statusCode, JSON.stringify(rule.state.body)).toBe(200);
    const sw = await callRoute(approvalEnforcement, tokens[a]!, c, 'POST', { documentType: 'supplier_invoice', enabled: true },
      '/api/accounting/approval-enforcement');
    expect(sw.state.statusCode, JSON.stringify(sw.state.body)).toBe(200);
    const role = await callRoute(companyUsers, tokens[o]!, c, 'PUT', { userId: m, role: 'admin' }, '/api/accounting/company-users');
    expect(role.state.statusCode, JSON.stringify(role.state.body)).toBe(200);
    const feed = await page(o, c, {});
    const latest = (type: string) => feed.items.find((i) => i.entityType === type)!;
    expect(latest('approval_rule')).toMatchObject({ op: 'create', actor: a, channel: 'session', entityLabel: 'ECR rule' });
    expect(latest('approval_enforcement')).toMatchObject({ op: 'create', actor: a, channel: 'session', entityLabel: 'supplier_invoice' });
    const member = latest('company_user');
    expect(member).toMatchObject({ op: 'update', actor: o, entityLabel: `${m}@test.local` });
    expect(member.fields).toEqual([{ key: 'role', before: 'manager', after: 'admin', masked: false }]);
    const dbRoles = (await pool.query("SELECT DISTINCT db_role FROM entity_changes WHERE company_id = $1 AND channel = 'session'", [c])).rows;
    expect(dbRoles).toEqual([{ db_role: 'app_user' }]);
  });
});

describe('reveal', () => {
  it('owner / admin see the full numbers and the reveal is audited; others and Login-as are refused', async () => {
    const c = await company();
    const s = await supplierViaRoute(c);
    const [created] = (await page(a, c, { entityType: 'supplier', entityId: s })).items;
    for (const user of [v, m]) expect((await reveal(user, c, created!.id)).state.statusCode).toBe(403);
    const imp = await impersonationToken(pool, a, o);
    const refused = await reveal(a, c, created!.id, imp);
    expect(refused.state.statusCode).toBe(403);
    expect(JSON.stringify(refused.state.body)).toContain('IMPERSONATION_FORBIDDEN');
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'entity_change'", [c])).rows[0].n)
      .toBe(0);
    const res = await reveal(a, c, created!.id);
    expect(res.state.statusCode).toBe(200);
    expect(field(dataOf<EntityChangeView>(res), 'bank_account_number')).toEqual(
      { key: 'bank_account_number', before: null, after: '1234567890', masked: false });
    const audit = (await pool.query("SELECT user_id, action, entity_id, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'entity_change'",
      [c])).rows;
    expect(audit).toEqual([{ user_id: a, action: 'export', entity_id: created!.id,
      changes: { fields: [], metadata: { revealed: 'bank_account_number', entityType: 'supplier', entityId: s, seq: created!.seq } } }]);
    expect((await reveal(a, c, crypto.randomUUID())).state.statusCode).toBe(404);
  });

  it('a change with nothing masked is returned without an audit row; another company cannot reveal it', async () => {
    const c = await company();
    const other = await company();
    const [created] = (await page(o, c, { entityType: 'company_user' })).items;
    expect((await reveal(o, c, created!.id)).state.statusCode).toBe(200);
    expect((await reveal(o, other, created!.id)).state.statusCode).toBe(404);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE company_id = ANY($1) AND entity_type = 'entity_change'",
      [[c, other]])).rows[0].n).toBe(0);
  });
});
