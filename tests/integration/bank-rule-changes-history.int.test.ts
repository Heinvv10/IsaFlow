/**
 * Bank-rule history (Hein's decision 3): EVERY rule write — the UI's create,
 * update, toggle, delete and bulk delete, the MCP tools, the seed route and a
 * customer merge — leaves one append-only before/after row, with enforcement
 * off and on (a suggestion-only rule is never held). The bulk delete refuses
 * the whole batch on a missing or foreign id. A merge under `bank_rule`
 * refuses, before any write, to re-point an AUTO-POSTING rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankRulesSeed from '../../pages/api/accounting/bank-rules-seed';
import customerMerge from '../../pages/api/accounting/customer-merge';
import { createRule } from '../../src/modules/accounting/services/bank/bankRulesService';
import { seedRules } from '../../src/modules/accounting/services/bank/bankRuleChangeControl';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';
import { journalCompany, type JournalCompany } from './r035-pr6.helpers';
import {
  cleanupRuleChanges, enforceRules, historyOf, mcpRules, plantBankRule, ruleOf, ruleRoutes,
} from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const r = ruleRoutes(tokens);
const mcp = mcpRules(pool);

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(() => cleanupRuleChanges(pool, companies, [a]));

async function fixture(enforced: boolean): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[a, 'admin']], companies);
  if (enforced) await enforceRules(pool, f.c, a);
  return f;
}
const applied = (rows: Awaited<ReturnType<typeof historyOf>>) => rows.map((h) => [h.kind, h.status, h.proposed_by]);

describe.each([false, true])('every UI writer records history (bank_rule enforced: %s)', (enforced) => {
  it('create, rename, toggle and delete each leave one applied row by the person, before/after', async () => {
    const f = await fixture(enforced);
    const created = await r.create(a, f.c, { glAccountId: f.expA });
    expect(created.state.statusCode, JSON.stringify(created.state.body)).toBe(200);
    const id = (created.state.body as { data: { id: string; status: string } }).data.id;
    expect((created.state.body as { data: { status: string } }).data.status).toBe('applied');
    expect((await r.action(a, f.c, { action: 'update', id, ruleName: 'BRC renamed' })).state.statusCode).toBe(200);
    expect((await r.action(a, f.c, { action: 'toggle', id, isActive: false })).state.statusCode).toBe(200);
    expect((await r.action(a, f.c, { action: 'delete', id })).state.statusCode).toBe(200);
    const h = await historyOf(pool, f.c, id);
    expect(applied(h)).toEqual([['create', 'applied', a], ['update', 'applied', a], ['toggle', 'applied', a], ['delete', 'applied', a]]);
    expect(h[0]!.before).toBeNull();
    expect(h[0]!.after).toMatchObject({ rule_name: 'BRC created', gl_account_id: f.expA, auto_create_entry: false });
    expect([h[1]!.before!.rule_name, h[1]!.after!.rule_name]).toEqual(['BRC created', 'BRC renamed']);
    expect([h[2]!.before!.is_active, h[2]!.after!.is_active]).toEqual([true, false]);
    expect([h[3]!.before!.rule_name, h[3]!.after]).toEqual(['BRC renamed', null]);
  });

  it('a bulk delete records one delete per rule; a missing or foreign id refuses the whole batch (404, nothing deleted)', async () => {
    const f = await fixture(enforced);
    const other = await fixture(false);
    const [x, y] = [await plantBankRule(pool, f.c, f.expA), await plantBankRule(pool, f.c, f.expB)];
    const foreign = await plantBankRule(pool, other.c, other.expA);
    for (const stranger of [foreign, crypto.randomUUID()]) {
      const res = await r.action(a, f.c, { action: 'deleteMany', ids: [x, y, stranger] });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(404);
      expect(reasonOf(res)).toBe('NOT_FOUND');
    }
    expect(await ruleOf(pool, x)).toBeDefined();
    expect(await ruleOf(pool, foreign)).toBeDefined();
    const res = await r.action(a, f.c, { action: 'deleteMany', ids: [y, x, x] });
    expect((res.state.body as { data: { deleted: number } }).data.deleted).toBe(2);
    for (const id of [x, y]) expect(applied(await historyOf(pool, f.c, id)).at(-1)).toEqual(['delete', 'applied', a]);
  });

  it('MCP create, update and disable each record a row by the token user', async () => {
    const f = await fixture(enforced);
    const made = await mcp(a, f.c, 'create_bank_rule', { rule_name: 'BRC mcp', match_field: 'description', match_type: 'contains',
      match_pattern: 'BRCMCP', gl_account_id: f.expA });
    expect(made.isError, made.content[0]!.text).toBeFalsy();
    const id = JSON.parse(made.content[0]!.text).id as string;
    expect((await mcp(a, f.c, 'update_bank_rule', { rule_id: id, rule_name: 'BRC mcp 2' })).isError).toBeFalsy();
    expect((await mcp(a, f.c, 'disable_bank_rule', { rule_id: id })).isError).toBeFalsy();
    expect(applied(await historyOf(pool, f.c, id))).toEqual([['create', 'applied', a], ['update', 'applied', a],
      ['toggle', 'applied', a]]);
  });

  it('the seed route records `seed` rows, and the declared kind does not outlive the seed', async () => {
    const f = await fixture(enforced);
    const code = (await pool.query('SELECT account_code FROM gl_accounts WHERE id = $1', [f.expA])).rows[0].account_code;
    const res = await callRoute(bankRulesSeed as never, tokens[a]!, f.c, 'POST',
      { entries: [{ originalCategory: 'BRC Seed One', glCode: code }, { originalCategory: 'BRC Seed Two', glCode: code }] },
      '/api/accounting/bank-rules-seed');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(applied(await historyOf(pool, f.c))).toEqual([['seed', 'applied', a], ['seed', 'applied', a]]);
    // One request transaction: a seed, then an ordinary create, is a `create`.
    await inRequest(pool, a, f.c, async () => {
      await seedRules(f.c, [{ ruleName: 'BRC Seed Three', pattern: 'brc seed three', glAccountId: f.expA }], a);
      await createRule(f.c, { ruleName: 'BRC after seed', matchField: 'description', matchType: 'contains', matchPattern: 'X',
        glAccountId: f.expA }, a);
    });
    expect((await historyOf(pool, f.c)).map((h) => h.kind)).toEqual(['seed', 'seed', 'seed', 'create']);
  });
});

describe('a customer merge', () => {
  const customer = async (c: string, name: string) => (await pool.query(
    'INSERT INTO customers(company_id, name) VALUES($1,$2) RETURNING id', [c, name])).rows[0].id as string;
  const merge = (c: string, source: string, target: string) => callRoute(customerMerge as never, tokens[a]!, c, 'POST',
    { source_id: source, target_id: target }, '/api/accounting/customer-merge');

  it('re-points a rule naming the source and records it as a `merge`', async () => {
    const f = await fixture(false);
    const [s, t] = [await customer(f.c, 'BRC Source'), await customer(f.c, 'BRC Target')];
    const rule = await plantBankRule(pool, f.c, f.expA, { clientId: s, autoPost: true });
    expect((await merge(f.c, s, t)).state.statusCode).toBe(200);
    expect((await ruleOf(pool, rule))!.client_id).toBe(t);
    const last = (await historyOf(pool, f.c, rule)).at(-1)!;
    expect([last.kind, last.before!.client_id, last.after!.client_id]).toEqual(['merge', s, t]);
  });

  it('under bank_rule: an AUTO-POSTING rule naming the source refuses the merge 409 before any write', async () => {
    const f = await fixture(true);
    const [s, t] = [await customer(f.c, 'BRC Source'), await customer(f.c, 'BRC Target')];
    const posting = await plantBankRule(pool, f.c, f.expA, { clientId: s, autoPost: true, name: 'BRC posting' });
    const res = await merge(f.c, s, t);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('RULE_MERGE_HELD');
    expect(JSON.stringify(res.state.body)).toMatch(/BRC posting.*auto-post off/);
    expect((await ruleOf(pool, posting))!.client_id).toBe(s);
    expect((await pool.query('SELECT deleted_at FROM customers WHERE id = $1', [s])).rows[0].deleted_at).toBeNull();
    // Suggestion-only: merges, recorded.
    await pool.query('UPDATE bank_categorisation_rules SET auto_create_entry = false WHERE id = $1', [posting]);
    expect((await merge(f.c, s, t)).state.statusCode).toBe(200);
    expect((await historyOf(pool, f.c, posting)).at(-1)!.kind).toBe('merge');
  });
});
