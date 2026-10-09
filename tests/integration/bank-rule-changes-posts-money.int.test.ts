/**
 * Breaker #684 REPRO 4 (the orchestrator's decision on Hein's decision 3): a
 * rule POSTS MONEY when it is active and either auto-posts itself
 * (auto_create_entry) or the company has auto-post enabled — smart-categorize
 * matches every active rule at 0.95 and autoPostGateService.sweep posts the
 * suggestion unattended. So, with auto-post on and `bank_rule` enforced:
 *  - re-pointing or creating a "suggestion-only" rule is held for approval,
 *    and the sweep then posts with the rule as it was, never the unapproved one;
 *  - disabling or deleting it still applies at once;
 *  - ENABLING auto-post makes every active rule post money, so it is a
 *    weakening of the auto-post settings that needs authority above the
 *    bank-rule approver role (owner at owner level).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import smartCategorize from '../../pages/api/accounting/smart-categorize';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA, plantBatch, plantLine, type BankCompany } from './bank-controls-a.helpers';
import { enforceRules, historyOf, plantBankRule, ruleOf, ruleRoutes } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', o: '' };
const r = ruleRoutes(tokens);

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, Object.values(u)));

async function fixture(opts: { autoPost: boolean }): Promise<BankCompany> {
  const f = await bankCompany(pool, [[u.o, 'owner'], [u.a, 'admin'], [u.b, 'admin']], companies);
  await enforceRules(pool, f.c, u.o);
  // As an owner set it before the switch.
  if (opts.autoPost) {
    await pool.query('INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap) VALUES($1, true, 0.90, 10000)', [f.c]);
  }
  return f;
}
const statusOf = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<{ status: string }>(res).status;
};
const postedTo = async (c: string, account: string) => (await pool.query(
  `SELECT EXISTS (SELECT 1 FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
                  WHERE je.company_id = $1 AND je.status = 'posted' AND jl.gl_account_id = $2) AS p`, [c, account])).rows[0].p as boolean;

describe('with auto-post enabled, a suggestion-only rule posts money', () => {
  it('re-pointing it is held; the sweep posts with the rule as it was, never to the unapproved account', async () => {
    const f = await fixture({ autoPost: true });
    const rule = await plantBankRule(pool, f.c, f.expA, { pattern: 'BRK684SUG' });
    const line = await plantLine(pool, f, await plantBatch(pool, f, u.b));
    await pool.query("UPDATE bank_transactions SET description = 'BRK684SUG debit' WHERE id = $1", [line]);
    expect(statusOf(await r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB }))).toBe('pending_approval');
    expect((await ruleOf(pool, rule))!.gl_account_id).toBe(f.expA);
    const res = await callRoute(smartCategorize as never, tokens[u.a]!, f.c, 'POST', { action: 'categorize', transactionIds: [line] },
      '/api/accounting/smart-categorize');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await postedTo(f.c, f.expB)).toBe(false);
  });

  it('creating an active suggestion rule is held; disabling and deleting one apply at once', async () => {
    const f = await fixture({ autoPost: true });
    expect(statusOf(await r.create(u.a, f.c, { glAccountId: f.expA }))).toBe('pending_approval');
    const rule = await plantBankRule(pool, f.c, f.expA);
    expect(statusOf(await r.action(u.a, f.c, { action: 'toggle', id: rule, isActive: false }))).toBe('applied');
    // Inactive, it posts nothing: editing it applies; re-activating it is held.
    expect(statusOf(await r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB }))).toBe('applied');
    expect(statusOf(await r.action(u.a, f.c, { action: 'toggle', id: rule, isActive: true }))).toBe('pending_approval');
    expect(statusOf(await r.action(u.a, f.c, { action: 'delete', id: rule }))).toBe('applied');
    expect((await historyOf(pool, f.c)).map((h) => [h.kind, h.status])).toEqual([
      ['create', 'pending'], ['create', 'applied'], ['toggle', 'applied'], ['update', 'applied'], ['toggle', 'superseded'],
      ['delete', 'applied']]);
  });

  it("the switch's preview counts every active rule while auto-post is on", async () => {
    const f = await fixture({ autoPost: true });
    await plantBankRule(pool, f.c, f.expA);
    await plantBankRule(pool, f.c, f.expA, { active: false });
    const res = await callRoute(approvalEnforcement as never, tokens[u.a]!, f.c, 'GET', undefined, '/api/accounting/approval-enforcement',
      { preview: '1' });
    expect(dataOf<{ preview: Record<string, number> }>(res).preview.bank_rule).toBe(1);
  });

  it('with auto-post off the same edit applies at once (suggestions post nothing)', async () => {
    const f = await fixture({ autoPost: false });
    const rule = await plantBankRule(pool, f.c, f.expA);
    expect(statusOf(await r.action(u.a, f.c, { action: 'update', id: rule, glAccountId: f.expB }))).toBe('applied');
  });
});

describe('enabling auto-post under bank_rule enforcement is a weakening', () => {
  const put = (user: string, c: string, body: Record<string, unknown>) => callRoute(bankAutoPost as never, tokens[user]!, c, 'PUT', body,
    '/api/accounting/bank-auto-post');
  const enabled = async (c: string) => (await pool.query('SELECT enabled FROM bank_auto_post_settings WHERE company_id = $1', [c]))
    .rows[0]?.enabled ?? false;

  it('an admin is refused 403 with nothing written; the owner may; tightening needs nobody', async () => {
    const f = await fixture({ autoPost: false });
    const refused = await put(u.a, f.c, { enabled: true });
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(403);
    expect(reasonOf(refused)).toBe('WEAKENING_REQUIRES_AUTHORITY');
    expect(JSON.stringify(refused.state.body)).toMatch(/Bank-rule approval is enforced/);
    expect(await enabled(f.c)).toBe(false);
    expect((await put(u.o, f.c, { enabled: true })).state.statusCode).toBe(200);
    expect(await enabled(f.c)).toBe(true);
    expect((await put(u.a, f.c, { enabled: false })).state.statusCode).toBe(200);
  });

  it('without bank_rule (or any) enforcement an admin enables it as before', async () => {
    const f = await bankCompany(pool, [[u.a, 'admin']], companies);
    expect((await put(u.a, f.c, { enabled: true })).state.statusCode).toBe(200);
  });
});
