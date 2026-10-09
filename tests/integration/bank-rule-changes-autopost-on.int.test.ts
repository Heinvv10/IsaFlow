/**
 * Breaker round 2, R2-2b (and the four holes announced with it): with auto-post
 * off, a suggest-only rule posts nothing, so changing it needs nobody. Under
 * `bank_rule`, switching auto-post back ON is therefore refused (409
 * AUTO_POST_RULES_UNREVIEWED, nothing written) while an active rule differs
 * from its state at the cutoff in a way that would have needed approval with
 * auto-post on, and someone other than the switcher made an unapproved change
 * in between. Judged over the whole span (a rename after a re-point still
 * counts), a re-created rule is a creation, the switcher's own changes never
 * block, and the cutoff (bank_rule's switch-on, or auto-post's last switch-off,
 * whichever is later) is kept where app_user cannot move it later.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import bankAutoPost from '../../pages/api/accounting/bank-auto-post';
import smartCategorize from '../../pages/api/accounting/smart-categorize';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA, plantBatch, plantLine, type BankCompany } from './bank-controls-a.helpers';
import { enforceRules, plantBankRule, ruleRoutes } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { o: '', a: '' };
const r = ruleRoutes(tokens);

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, Object.values(u)));

const put = (user: string, c: string, body: Record<string, unknown>) => callRoute(bankAutoPost as never, tokens[user]!, c, 'PUT', body,
  '/api/accounting/bank-auto-post');
const enabled = async (c: string) => (await pool.query('SELECT enabled FROM bank_auto_post_settings WHERE company_id = $1', [c]))
  .rows[0]?.enabled ?? false;
const status = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<{ status: string }>(res).status;
};
/** Owner and admin; bank_rule on; auto-post on (set before the switch); a suggest-only rule; the admin switches auto-post off. */
async function staged(): Promise<BankCompany & { rule: string }> {
  const f = await bankCompany(pool, [[u.o, 'owner'], [u.a, 'admin']], companies);
  await pool.query('INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap) VALUES($1,true,0.90,10000)', [f.c]);
  const rule = await plantBankRule(pool, f.c, f.expA, { pattern: 'BRK684R22B' });
  await enforceRules(pool, f.c, u.o);
  expect((await put(u.a, f.c, { enabled: false })).state.statusCode).toBe(200); // tightening: anyone
  return { ...f, rule };
}
const refusedOn = async (user: string, c: string, names: RegExp) => {
  const res = await put(user, c, { enabled: true });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
  expect(reasonOf(res)).toBe('AUTO_POST_RULES_UNREVIEWED');
  expect(JSON.stringify(res.state.body)).toMatch(names);
  expect(await enabled(c)).toBe(false);
};

describe('R2-2b: a rule changed while auto-post was off blocks switching it on', () => {
  it('the owner cannot switch auto-post on over the admin\'s unapproved re-point; nothing posts to it; the way out works', async () => {
    const f = await staged();
    expect(status(await r.action(u.a, f.c, { action: 'update', id: f.rule, glAccountId: f.expB }))).toBe('applied');
    expect((await put(u.a, f.c, { enabled: true })).state.statusCode).toBe(403); // below the authority
    await refusedOn(u.o, f.c, /BRC rule.*Disable them first/);
    const line = await plantLine(pool, f, await plantBatch(pool, f, u.o));
    await pool.query("UPDATE bank_transactions SET description = 'BRK684R22B debit' WHERE id = $1", [line]);
    await callRoute(smartCategorize as never, tokens[u.a]!, f.c, 'POST', { action: 'categorize', transactionIds: [line] },
      '/api/accounting/smart-categorize');
    expect((await pool.query("SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND status = 'posted'", [f.c]))
      .rows[0].n).toBe(0);
    // The way out: disable it; auto-post goes on; re-activating it is then held for a second person.
    expect(status(await r.action(u.o, f.c, { action: 'toggle', id: f.rule, isActive: false }))).toBe('applied');
    expect((await put(u.o, f.c, { enabled: true })).state.statusCode).toBe(200);
    expect(status(await r.action(u.a, f.c, { action: 'toggle', id: f.rule, isActive: true }))).toBe('pending_approval');
  });

  it('hole 1: a rename after the re-point (even by the owner) does not hide it', async () => {
    const f = await staged();
    status(await r.action(u.a, f.c, { action: 'update', id: f.rule, glAccountId: f.expB }));
    status(await r.action(u.o, f.c, { action: 'update', id: f.rule, ruleName: 'Renamed by owner' }));
    await refusedOn(u.o, f.c, /Renamed by owner/);
  });

  it('hole 2: deleting the rule and creating it again with a new target is a creation, and counts', async () => {
    const f = await staged();
    status(await r.action(u.a, f.c, { action: 'delete', id: f.rule }));
    expect(status(await r.create(u.a, f.c, { ruleName: 'Re-created', matchPattern: 'BRK684R22B', glAccountId: f.expB }))).toBe('applied');
    await refusedOn(u.o, f.c, /Re-created/);
  });

  it("the switcher's own changes, and cosmetic changes by others, do not block", async () => {
    const own = await staged();
    status(await r.action(u.o, own.c, { action: 'update', id: own.rule, glAccountId: own.expB }));
    expect((await put(u.o, own.c, { enabled: true })).state.statusCode).toBe(200);
    const cosmetic = await staged();
    status(await r.action(u.a, cosmetic.c, { action: 'update', id: cosmetic.rule, ruleName: 'Only a name', descriptionTemplate: 'x' }));
    expect((await put(u.o, cosmetic.c, { enabled: true })).state.statusCode).toBe(200);
  });
});

describe('hole 3: the cutoff', () => {
  it("no settings row ever: bank_rule's switch-on is the cutoff — a rule created after it blocks, one changed before it does not", async () => {
    const f = await bankCompany(pool, [[u.o, 'owner'], [u.a, 'admin']], companies);
    const before = await plantBankRule(pool, f.c, f.expA);
    await pool.query('UPDATE bank_categorisation_rules SET gl_account_id = $2 WHERE id = $1', [before, f.expB]); // before the switch
    await enforceRules(pool, f.c, u.o);
    expect((await put(u.o, f.c, { enabled: true })).state.statusCode).toBe(200);
    expect((await put(u.o, f.c, { enabled: false })).state.statusCode).toBe(200);
    const g = await bankCompany(pool, [[u.o, 'owner'], [u.a, 'admin']], companies);
    await enforceRules(pool, g.c, u.o);
    status(await r.create(u.a, g.c, { ruleName: 'After the switch', glAccountId: g.expA }));
    await refusedOn(u.o, g.c, /After the switch/);
  });

  it('app_user cannot move the switch-off time later: a direct write is ignored, a deleted and re-inserted row only moves it earlier', async () => {
    const f = await staged();
    status(await r.action(u.a, f.c, { action: 'update', id: f.rule, glAccountId: f.expB }));
    const asApp = async (fn: (db: PoolClient) => Promise<unknown>) => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: u.a, session_id: crypto.randomUUID() })]);
        await db.query("SELECT set_config('app.current_company_id', $1, true)", [f.c]);
        await db.query('SET LOCAL ROLE app_user');
        await fn(db);
        await db.query('COMMIT');
      } finally { db.release(); }
    };
    const disabledAt = async () => (await pool.query('SELECT disabled_at FROM bank_auto_post_settings WHERE company_id = $1', [f.c]))
      .rows[0].disabled_at as Date | null;
    const was = await disabledAt();
    expect(was).not.toBeNull();
    await asApp((db) => db.query("UPDATE bank_auto_post_settings SET disabled_at = now() + interval '1 day' WHERE company_id = $1", [f.c]));
    expect(await disabledAt()).toEqual(was);
    await asApp(async (db) => {
      await db.query('DELETE FROM bank_auto_post_settings WHERE company_id = $1', [f.c]);
      await db.query('INSERT INTO bank_auto_post_settings(company_id, enabled) VALUES($1, false)', [f.c]);
    });
    expect(await disabledAt()).toBeNull();
    await refusedOn(u.o, f.c, /BRC rule/);
  });
});
