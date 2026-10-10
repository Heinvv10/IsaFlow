/**
 * WHO may decide a held bank-rule change (Hein's decision 3): a person in
 * their own cookie session — never "login as", never an agent (MCP proposes,
 * the route refuses a claims-without-session context) — holding the
 * manual-journal approver role (never below admin; an owner-level rule raises
 * it), who did not propose it, except as R-035's sole approver on the admin
 * floor (recorded with the roster). Another company can neither see nor
 * decide the change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { journalCompany, journalRule } from './r035-pr6.helpers';
import { cleanupRuleChanges, enforceRules, historyOf, mcpRules, ruleRoutes } from './bank-rule-changes.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
/** a, b: admins; m: manager (below admin); o: owner; x: never a member of A. */
const u = { a: '', b: '', m: '', o: '', x: '' };
const r = ruleRoutes(tokens);
const mcp = mcpRules(pool);

beforeAll(async () => { for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [Object.values(u)]);
  await cleanupRuleChanges(pool, companies, Object.values(u));
});

async function fixture(members: [string, string][]) {
  const f = await journalCompany(pool, members, companies);
  await enforceRules(pool, f.c, members[0]![0]);
  return f;
}
const propose = async (user: string, c: string, gl: string) => {
  const res = await r.create(user, c, { glAccountId: gl, autoCreateEntry: true });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return dataOf<{ changeId: string }>(res).changeId;
};
const refused = (res: { state: { statusCode: number; body: unknown } }, status: number, reason: string) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(status);
  expect(reasonOf(res)).toBe(reason);
};
const decided = async (id: string) => (await pool.query(
  'SELECT decided_by, roster_snapshot FROM bank_rule_change_decisions WHERE change_id = $1', [id])).rows[0];

describe('sessions', () => {
  it('login-as is refused 403; a token without a session (an agent) is refused 403 AGENT_FORBIDDEN', async () => {
    const f = await fixture([[u.a, 'admin'], [u.b, 'admin']]);
    const id = await propose(u.a, f.c, f.expA);
    const digest = (await r.changes(u.b, f.c))[0]!.digest;
    refused(await r.decide(u.b, f.c, id, 'approve', { digest }, await impersonationToken(pool, u.b, u.x)), 403, 'IMPERSONATION_FORBIDDEN');
    const agent = await new SignJWT({ sub: u.b, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    refused(await r.decide(u.b, f.c, id, 'approve', { digest }, agent), 403, 'AGENT_FORBIDDEN');
    refused(await r.decide(u.b, f.c, id, 'reject', { digest }, agent), 403, 'AGENT_FORBIDDEN');
    expect(await decided(id)).toBeUndefined();
    expect((await r.changes(u.b, f.c))[0]!.canDecide).toBe(true);
  });

  it('MCP proposes (pending) and has no way to decide; a person then approves it', async () => {
    const f = await fixture([[u.a, 'admin'], [u.b, 'admin']]);
    const out = await mcp(u.a, f.c, 'create_bank_rule', { rule_name: 'BRC agent', match_field: 'description',
      match_type: 'contains', match_pattern: 'AGENT', gl_account_id: f.expA, auto_create_entry: true });
    const id = (JSON.parse(out.content[0]!.text) as { change_id: string }).change_id;
    expect((await historyOf(pool, f.c)).map((h) => [h.id, h.status, h.proposed_by])).toEqual([[id, 'pending', u.a]]);
    expect((await r.decide(u.b, f.c, id, 'approve')).state.statusCode).toBe(200);
  });
});

describe('roles', () => {
  it('a member below admin is refused 403 APPROVER_ROLE_REQUIRED, and is shown no Approve', async () => {
    const f = await fixture([[u.a, 'admin'], [u.m, 'manager']]);
    const id = await propose(u.a, f.c, f.expA);
    expect((await r.changes(u.m, f.c))[0]!.canDecide).toBe(false);
    refused(await r.decide(u.m, f.c, id, 'approve'), 403, 'APPROVER_ROLE_REQUIRED');
    refused(await r.decide(u.m, f.c, id, 'reject'), 403, 'APPROVER_ROLE_REQUIRED');
  });

  it('an owner-level manual_journal rule raises the approver to owner', async () => {
    const f = await fixture([[u.a, 'admin'], [u.b, 'admin'], [u.o, 'owner']]);
    await journalRule(plantRule, pool, f.c, { role: 'owner' });
    const id = await propose(u.a, f.c, f.expA);
    refused(await r.decide(u.b, f.c, id, 'approve'), 403, 'APPROVER_ROLE_REQUIRED');
    expect((await r.decide(u.o, f.c, id, 'approve')).state.statusCode).toBe(200);
  });

  it('raised to owner, but the sole owner proposed it: another admin may decide (the floor suffices)', async () => {
    const f = await fixture([[u.o, 'owner'], [u.b, 'admin']]);
    await journalRule(plantRule, pool, f.c, { role: 'owner' });
    const id = await propose(u.o, f.c, f.expA);
    expect((await r.changes(u.b, f.c))[0]!.canDecide).toBe(true);
    expect((await r.decide(u.b, f.c, id, 'approve')).state.statusCode).toBe(200);
  });
});

describe('the sole approver', () => {
  it('decides their own change, recorded with the roster; a second admin ends the exception', async () => {
    const f = await fixture([[u.a, 'admin'], [u.m, 'manager']]);
    const id = await propose(u.a, f.c, f.expA);
    expect((await r.changes(u.a, f.c))[0]!.canDecide).toBe(true);
    expect((await r.decide(u.a, f.c, id, 'approve')).state.statusCode).toBe(200);
    const row = await decided(id);
    expect(row.decided_by).toBe(u.a);
    expect(row.roster_snapshot).not.toBeNull();
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [f.c, u.b]);
    const next = await propose(u.a, f.c, f.expB);
    refused(await r.decide(u.a, f.c, next, 'approve'), 403, 'PROPOSER_MAY_NOT_DECIDE');
  });
});

describe('tenants', () => {
  it("another company sees none of A's changes and cannot decide one (404)", async () => {
    const f = await fixture([[u.a, 'admin'], [u.b, 'admin']]);
    const other = await fixture([[u.x, 'admin'], [u.b, 'admin']]);
    const id = await propose(u.a, f.c, f.expA);
    const digest = (await r.changes(u.b, f.c))[0]!.digest;
    expect(await r.changes(u.x, other.c, { status: 'all' })).toEqual([]);
    expect(await r.changes(u.b, other.c, { status: 'all' })).toEqual([]);
    refused(await r.decide(u.x, other.c, id, 'approve', { digest }), 404, 'NOT_FOUND');
    refused(await r.decide(u.b, other.c, id, 'approve', { digest }), 404, 'NOT_FOUND');
    expect(await decided(id)).toBeUndefined();
  });
});
