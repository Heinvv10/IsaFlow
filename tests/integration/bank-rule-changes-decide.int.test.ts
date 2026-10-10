/**
 * Deciding a held bank-rule change (Hein's decision 3): another permitted
 * person approves it and it applies atomically — the rule then posts when
 * the rules run — or rejects it and the rule stays as it was. A change is
 * decided once; a wrong digest, or a rule that moved since the proposal, is
 * refused 409 with nothing written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { journalCompany, type JournalCompany } from './r035-pr6.helpers';
import {
  cleanupRuleChanges, enforceRules, historyOf, moveRuleSilently, plantBankRule, ruleOf, ruleRoutes,
} from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = ruleRoutes(tokens);

beforeAll(async () => { for (const k of ['a', 'b'] as const) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupRuleChanges(pool, companies, Object.values(u)));

async function fixture(): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[u.a, 'admin'], [u.b, 'admin']], companies);
  await enforceRules(pool, f.c, u.a);
  return f;
}
const changeId = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<{ changeId: string }>(res).changeId;
};
const refused = (res: { state: { statusCode: number; body: unknown } }, status: number, reason: string) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(status);
  expect(reasonOf(res)).toBe(reason);
};
const decisions = async (c: string) => Number((await pool.query(
  "SELECT count(*) FROM bank_rule_change_decisions WHERE company_id = $1 AND decision <> 'superseded'", [c])).rows[0].count);
const line = async (f: JournalCompany) => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
   VALUES($1,$2,DATE '2026-09-01',-250,'BRCMATCH debit','imported',$3) RETURNING id`, [f.c, f.bank, crypto.randomUUID()])).rows[0].id;

describe('approve', () => {
  it('the proposer cannot approve or reject; another admin approves, the rule is created auto-posting, and then posts', async () => {
    const f = await fixture();
    const id = changeId(await r.create(u.a, f.c, { glAccountId: f.expA, autoCreateEntry: true }));
    const [listed] = await r.changes(u.b, f.c);
    expect(listed).toMatchObject({ id, kind: 'create', status: 'pending', ruleId: null, ruleName: 'BRC created', canDecide: true });
    expect((await r.changes(u.a, f.c))[0]!.canDecide).toBe(false);
    refused(await r.decide(u.a, f.c, id, 'approve'), 403, 'PROPOSER_MAY_NOT_DECIDE');
    refused(await r.decide(u.a, f.c, id, 'reject'), 403, 'PROPOSER_MAY_NOT_DECIDE');
    expect(await decisions(f.c)).toBe(0);
    const ok = await r.decide(u.b, f.c, id, 'approve', { note: 'Checked the account' });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    const ruleId = dataOf<{ status: string; ruleId: string }>(ok).ruleId;
    expect(dataOf<{ status: string }>(ok).status).toBe('approved');
    expect(await ruleOf(pool, ruleId)).toMatchObject({ company_id: f.c, auto_create_entry: true, is_active: true,
      gl_account_id: f.expA, created_by: u.a });
    // Recorded once, by the change and its decision — the application adds no second history row.
    expect((await historyOf(pool, f.c)).map((h) => [h.kind, h.status, h.rule_id])).toEqual([['create', 'approved', ruleId]]);
    const tx = await line(f);
    const run = await r.action(u.b, f.c, { action: 'apply', bankAccountId: f.bank });
    expect(run.state.statusCode, JSON.stringify(run.state.body)).toBe(200);
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [tx])).rows[0].status).toBe('allocated');
  });

  it('an approved update applies every column of `after`, atomically; the other pending change on the rule is superseded', async () => {
    const f = await fixture();
    const rule = await plantBankRule(pool, f.c, f.expA);
    const first = changeId(await r.action(u.a, f.c, { action: 'update', id: rule, autoCreateEntry: true }));
    expect((await r.decide(u.b, f.c, first, 'approve')).state.statusCode).toBe(200);
    const gl = changeId(await r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB }));
    const prio = changeId(await r.action(u.b, f.c, { action: 'update', id: rule, priority: 7 }));
    // gl was superseded by prio's proposal; prio is decided by a.
    refused(await r.decide(u.b, f.c, gl, 'approve'), 409, 'CHANGE_NOT_PENDING');
    expect((await r.decide(u.a, f.c, prio, 'approve')).state.statusCode).toBe(200);
    expect(await ruleOf(pool, rule)).toMatchObject({ auto_create_entry: true, priority: 7, gl_account_id: f.expA });
    expect((await historyOf(pool, f.c, rule)).map((h) => h.status)).toEqual(['applied', 'approved', 'superseded', 'approved']);
  });
});

describe('refused, nothing written', () => {
  it('a stale approval (the rule moved since the proposal) is 409 RULE_CHANGED', async () => {
    const f = await fixture();
    const rule = await plantBankRule(pool, f.c, f.expA, { autoPost: true });
    const id = changeId(await r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB }));
    await moveRuleSilently(pool, rule, "match_pattern = 'MOVED'");
    const res = await r.decide(u.b, f.c, id, 'approve');
    refused(res, 409, 'RULE_CHANGED');
    expect(JSON.stringify(res.state.body)).toMatch(/changed since it was proposed.*propose it again/);
    expect(await ruleOf(pool, rule)).toMatchObject({ gl_account_id: f.expA, match_pattern: 'MOVED' });
    expect(await decisions(f.c)).toBe(0);
  });

  it('a change superseded by a later edit to its rule cannot be approved (409)', async () => {
    const f = await fixture();
    const rule = await plantBankRule(pool, f.c, f.expA, { autoPost: true });
    const id = changeId(await r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB }));
    expect((await r.action(u.a, f.c, { action: 'update', id: rule, ruleName: 'BRC renamed' })).state.statusCode).toBe(200);
    refused(await r.decide(u.b, f.c, id, 'approve'), 409, 'CHANGE_NOT_PENDING');
    expect((await ruleOf(pool, rule))!.gl_account_id).toBe(f.expA);
  });

  it('a wrong digest is 409 DIGEST_MISMATCH', async () => {
    const f = await fixture();
    const id = changeId(await r.create(u.a, f.c, { glAccountId: f.expA, autoCreateEntry: true }));
    refused(await r.decide(u.b, f.c, id, 'approve', { digest: 'f'.repeat(64) }), 409, 'DIGEST_MISMATCH');
    expect(await decisions(f.c)).toBe(0);
  });
});

describe('reject', () => {
  it('leaves the rule unchanged; a decided change cannot be decided again', async () => {
    const f = await fixture();
    const rule = await plantBankRule(pool, f.c, f.expA, { autoPost: true });
    const before = await ruleOf(pool, rule);
    const id = changeId(await r.action(u.a, f.c, { action: 'update', id: rule, supplierId: null, glAccountId: f.expB }));
    const res = await r.decide(u.b, f.c, id, 'reject', { note: 'Wrong account' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ status: string }>(res).status).toBe('rejected');
    expect(await ruleOf(pool, rule)).toEqual(before);
    refused(await r.decide(u.b, f.c, id, 'approve'), 409, 'CHANGE_NOT_PENDING');
    refused(await r.decide(u.b, f.c, id, 'reject'), 409, 'CHANGE_NOT_PENDING');
    const all = await r.changes(u.b, f.c, { status: 'all', ruleId: rule });
    expect(all.map((c) => c.status)).toEqual(['rejected', 'applied']);
    expect(all[0]!.changes).toEqual([{ key: 'gl_account_id', before: f.expA, after: f.expB }]);
    expect(await r.changes(u.b, f.c)).toEqual([]);
  });
});
