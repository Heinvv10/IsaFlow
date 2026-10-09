/**
 * Under the `bank_rule` switch (Hein's decision 3), a change that makes a rule
 * auto-post, or moves where / what an auto-posting rule posts, is HELD: a
 * pending change, nothing applied. The creating route then posts nothing on
 * the spot. Making a rule safer (auto-post off, disable, delete), renaming it,
 * and editing a suggestion-only rule apply at once. A held creation's `after`
 * is exactly the row an immediate creation inserts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { journalCompany, type JournalCompany } from './r035-pr6.helpers';
import { cleanupRuleChanges, enforceRules, historyOf, mcpRules, plantBankRule, ruleOf, ruleRoutes } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
const r = ruleRoutes(tokens);
const mcp = mcpRules(pool);

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(() => cleanupRuleChanges(pool, companies, [a]));

async function fixture(enforced = true): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[a, 'admin']], companies);
  if (enforced) await enforceRules(pool, f.c, a);
  return f;
}
type Held = { status: string; changeId: string };
const held = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  const d = dataOf<Held>(res);
  expect(d.status).toBe('pending_approval');
  expect(d.changeId).toMatch(/^[0-9a-f-]{36}$/);
  return d.changeId;
};
const appliedOk = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  expect(dataOf<Held>(res).status).toBe('applied');
};
const pendingOf = async (c: string) => (await historyOf(pool, c)).filter((h) => h.status === 'pending');
const line = async (f: JournalCompany) => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
   VALUES($1,$2,DATE '2026-09-01',-250,'BRCMATCH debit','imported',$3) RETURNING id`, [f.c, f.bank, crypto.randomUUID()])).rows[0].id;

describe('held, not applied', () => {
  it('creating an auto-posting rule: no rule, a pending create, and the route posts nothing on the spot', async () => {
    const f = await fixture();
    const tx = await line(f);
    const id = held(await r.create(a, f.c, { glAccountId: f.expA, autoCreateEntry: true, bankAccountId: f.bank }));
    expect(Number((await pool.query('SELECT count(*) FROM bank_categorisation_rules WHERE company_id = $1', [f.c])).rows[0].count)).toBe(0);
    const [p] = await pendingOf(f.c);
    expect([p!.id, p!.kind, p!.rule_id, p!.before, p!.proposed_by]).toEqual([id, 'create', null, null, a]);
    expect(p!.after).toMatchObject({ auto_create_entry: true, gl_account_id: f.expA, is_active: true });
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [tx])).rows[0].status).toBe('imported');
    expect(Number((await pool.query('SELECT count(*) FROM gl_journal_entries WHERE company_id = $1', [f.c])).rows[0].count)).toBe(0);
  });

  it('turning auto-post on, re-activating an auto-posting rule, and every target change on one are held', async () => {
    const f = await fixture();
    const supplier = (await pool.query("INSERT INTO suppliers(company_id,name) VALUES($1,'BRC Sup') RETURNING id", [f.c])).rows[0].id;
    const client = (await pool.query("INSERT INTO customers(company_id,name) VALUES($1,'BRC Cust') RETURNING id", [f.c])).rows[0].id;
    const suggest = await plantBankRule(pool, f.c, f.expA);
    held(await r.action(a, f.c, { action: 'update', id: suggest, autoCreateEntry: true }));
    const inactive = await plantBankRule(pool, f.c, f.expA, { autoPost: true, active: false });
    held(await r.action(a, f.c, { action: 'toggle', id: inactive, isActive: true }));
    expect((await historyOf(pool, f.c, inactive)).at(-1)!.kind).toBe('toggle');
    const posting = await plantBankRule(pool, f.c, f.expA, { autoPost: true });
    const before = await ruleOf(pool, posting);
    for (const change of [{ glAccountId: f.expB }, { supplierId: supplier }, { clientId: client }, { vatCode: 'standard' },
      { matchPattern: 'OTHER' }, { matchType: 'exact' }, { priority: 5 }, { autoApply: 'none' }]) {
      held(await r.action(a, f.c, { action: 'update', id: posting, ...change }));
    }
    expect(await ruleOf(pool, posting)).toEqual(before);
    expect((await ruleOf(pool, suggest))!.auto_create_entry).toBe(false);
    expect((await ruleOf(pool, inactive))!.is_active).toBe(false);
    // Each newer held change superseded the one before it on the same rule.
    expect((await historyOf(pool, f.c, posting)).map((h) => h.status)).toEqual(['applied', ...Array(7).fill('superseded'), 'pending']);
  });

  it('MCP: an auto-posting create, update or re-enable is held with a clear result, not an error', async () => {
    const f = await fixture();
    const made = await mcp(a, f.c, 'create_bank_rule', { rule_name: 'BRC mcp', match_field: 'description', match_type: 'contains',
      match_pattern: 'BRCMCP', gl_account_id: f.expA, auto_create_entry: true });
    expect(made.isError).toBeFalsy();
    expect(made.content[0]!.text).toMatch(/held for approval \(change [0-9a-f-]{36}\).*Bank rules page/i);
    const suggest = await plantBankRule(pool, f.c, f.expA);
    expect((await mcp(a, f.c, 'update_bank_rule', { rule_id: suggest, auto_create_entry: true })).content[0]!.text)
      .toMatch(/held for approval/i);
    const posting = await plantBankRule(pool, f.c, f.expA, { autoPost: true, active: false });
    expect((await mcp(a, f.c, 'disable_bank_rule', { rule_id: posting, enable: true })).content[0]!.text).toMatch(/held for approval/i);
    expect((await pendingOf(f.c)).map((p) => [p.kind, p.proposed_by])).toEqual([['create', a], ['update', a], ['toggle', a]]);
    expect((await ruleOf(pool, posting))!.is_active).toBe(false);
    expect((await ruleOf(pool, suggest))!.auto_create_entry).toBe(false);
  });
});

describe('applied at once, with history', () => {
  it('auto-post off, disable, rename and delete of an auto-posting rule; any edit of a suggestion-only rule', async () => {
    const f = await fixture();
    const posting = await plantBankRule(pool, f.c, f.expA, { autoPost: true });
    appliedOk(await r.action(a, f.c, { action: 'update', id: posting, ruleName: 'BRC renamed', descriptionTemplate: 'x' }));
    appliedOk(await r.action(a, f.c, { action: 'toggle', id: posting, isActive: false }));
    held(await r.action(a, f.c, { action: 'toggle', id: posting, isActive: true })); // re-activating it would auto-post
    appliedOk(await r.action(a, f.c, { action: 'update', id: posting, autoCreateEntry: false }));
    appliedOk(await r.action(a, f.c, { action: 'update', id: posting, glAccountId: f.expB, priority: 1, isActive: true }));
    appliedOk(await r.action(a, f.c, { action: 'delete', id: posting }));
    expect((await historyOf(pool, f.c, posting)).map((h) => [h.kind, h.status])).toEqual([
      ['create', 'applied'], ['update', 'applied'], ['toggle', 'applied'], ['toggle', 'superseded'], ['update', 'applied'],
      ['update', 'applied'], ['delete', 'applied']]);
  });

  it('enforcement off: an auto-posting create applies and the route runs it on the spot', async () => {
    const f = await fixture(false);
    const tx = await line(f);
    const res = await r.create(a, f.c, { glAccountId: f.expA, autoCreateEntry: true, bankAccountId: f.bank });
    appliedOk(res);
    expect(dataOf<{ applied: number }>(res).applied).toBe(1);
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [tx])).rows[0].status).toBe('allocated');
  });
});

describe("a held creation's `after`", () => {
  it('is the projection of the row an immediate creation of the same input inserts, every default included', async () => {
    const input = { autoCreateEntry: true, ruleName: 'BRC pin', matchPattern: 'PIN', vatCode: 'standard' };
    const on = await fixture();
    held(await r.create(a, on.c, { ...input, glAccountId: on.expA }));
    const [p] = await pendingOf(on.c);
    const off = await fixture(false);
    const res = await r.create(a, off.c, { ...input, glAccountId: off.expA });
    appliedOk(res);
    const { rows: [row] } = await pool.query('SELECT bank_rule_projection(to_jsonb(r)) AS p FROM bank_categorisation_rules r WHERE id = $1',
      [dataOf<{ id: string }>(res).id]);
    expect({ ...p!.after, gl_account_id: null }).toEqual({ ...row.p, gl_account_id: null });
    // The DB agrees it is the same rule (jsonb equality, numerics by value).
    expect((await pool.query("SELECT ($1::jsonb - 'gl_account_id') = ($2::jsonb - 'gl_account_id') AS same",
      [JSON.stringify(p!.after), JSON.stringify(row.p)])).rows[0].same).toBe(true);
  });
});

describe('the switch preview', () => {
  it('counts the active auto-posting rules (not inactive or suggest-only ones)', async () => {
    const f = await fixture(false);
    await plantBankRule(pool, f.c, f.expA, { autoPost: true });
    await plantBankRule(pool, f.c, f.expA, { autoPost: true, active: false });
    await plantBankRule(pool, f.c, f.expA);
    const res = await callRoute(approvalEnforcement as never, tokens[a]!, f.c, 'GET', undefined, '/api/accounting/approval-enforcement',
      { preview: '1' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ preview: Record<string, number> }>(res).preview.bank_rule).toBe(1);
  });
});
