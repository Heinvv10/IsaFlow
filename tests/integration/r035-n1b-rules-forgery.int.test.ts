/**
 * R-035 N1b (B, migration 881): approval_rules and approval_enforcement refuse
 * every direct write from the roles the app and the admin platform connect as.
 * Each forgery is attempted as raw SQL, under real claims, against a company
 * whose supplier-invoice gate is ON with an owner-level rule and a bill
 * pending approval — as app_user and as platform_admin (BYPASSRLS) — and the
 * bill stays unpostable afterwards. Calling the definers directly, past every
 * TypeScript check, is refused too. The catalogue half is
 * r035-n1b-rules-catalog; the per-class TS/SQL parity is r035-n1b-rules-parity.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupPr2, routes } from './r035-pr2.helpers';
import { asRole, n1Users, outcome, pendingBill } from './r035-n1.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u: Awaited<ReturnType<typeof n1Users>>;
const r = routes(tokens);
const DENIED = '42501';

beforeAll(async () => { u = await n1Users(pool, tokens); });
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

const rule = async (id: string) => (await pool.query(
  'SELECT is_active, approver_role, condition_operator, condition_value::TEXT AS value FROM approval_rules WHERE id = $1',
  [id])).rows[0];
const switches = async (c: string) => (await pool.query(
  'SELECT document_type FROM approval_enforcement WHERE company_id = $1 ORDER BY 1', [c])).rows.map((x) => x.document_type);
/** The gate still holds: the manager cannot approve the bill the owner rule governs. */
const stillGated = async (f: { c: string; bill: { id: string } }) =>
  expect((await r.approveBill(u.m, f.c, f.bill.id)).state.statusCode).toBe(409);

describe.each(['app_user', 'platform_admin'] as const)('as %s, raw SQL cannot', (role) => {
  const as = (c: string, fn: (cl: PoolClient) => Promise<unknown>) => asRole(pool, role, c, { sub: u.m }, fn, true);

  it.each([
    ['deactivate the owner rule', 'is_active = false'],
    ['lower its approver role', "approver_role = 'viewer'"],
    ['narrow its amounts', "condition_operator = 'greater_than', condition_value = 9999999"],
  ])('%s', async (_label, set) => {
    const f = await pendingBill(pool, tokens, u, companies);
    const before = await rule(f.ownerRule);
    expect(await outcome(as(f.c, (cl) => cl.query(`UPDATE approval_rules SET ${set} WHERE id = $1`, [f.ownerRule])))).toBe(DENIED);
    expect(await rule(f.ownerRule)).toEqual(before);
  });

  it('delete the owner rule', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.b, requester: u.b });
    await pool.query('UPDATE approval_requests SET rule_id = NULL WHERE company_id = $1', [f.c]); // no FK in the way
    expect(await outcome(as(f.c, (cl) => cl.query('DELETE FROM approval_rules WHERE id = $1', [f.ownerRule])))).toBe(DENIED);
    expect(await rule(f.ownerRule)).toBeDefined();
  });

  it('insert a lax rule beside the strict one', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(as(f.c, (cl) => cl.query(
      `INSERT INTO approval_rules(company_id, name, document_type, condition_operator, condition_value, approver_role)
       VALUES($1, 'lax', 'supplier_invoice', 'any', 0, 'viewer')`, [f.c])))).toBe(DENIED);
    expect((await pool.query("SELECT 1 FROM approval_rules WHERE company_id = $1 AND name = 'lax'", [f.c])).rows).toEqual([]);
  });

  it('lock a rule FOR UPDATE', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.m }, (cl) => cl.query(
      'SELECT id FROM approval_rules WHERE id = $1 FOR UPDATE', [f.ownerRule])))).toBe(DENIED);
  });

  it('delete the switch row — and the bill stays gated', async () => {
    const f = await pendingBill(pool, tokens, u, companies, { creator: u.b, requester: u.b });
    expect(await outcome(as(f.c, (cl) => cl.query('DELETE FROM approval_enforcement WHERE company_id = $1', [f.c])))).toBe(DENIED);
    expect(await switches(f.c)).toEqual(['supplier_invoice']);
    await stillGated(f);
  });

  it.each([
    ['move the switch to another type', "UPDATE approval_enforcement SET document_type = 'manual_journal' WHERE company_id = $1"],
    ['insert a switch', "INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1, 'customer_invoice', 'x')"],
    ['truncate the switchboard', 'TRUNCATE approval_enforcement'],
  ])('%s', async (_label, statement) => {
    const f = await pendingBill(pool, tokens, u, companies);
    const run = statement.startsWith('TRUNCATE')
      ? asRole(pool, role, f.c, { sub: u.m }, (cl) => cl.query(statement))
      : as(f.c, (cl) => cl.query(statement, [f.c]));
    expect(await outcome(run)).toBe(DENIED);
    expect(await switches(f.c)).toEqual(['supplier_invoice']);
  });

  it('still READ both tables (every gate reads them)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(asRole(pool, role, f.c, { sub: u.m }, (cl) => cl.query(
      'SELECT (SELECT count(*) FROM approval_rules WHERE company_id = $1) + (SELECT count(*) FROM approval_enforcement WHERE company_id = $1)',
      [f.c])))).toBe('ok');
  });
});

describe('the definers, called directly past every TypeScript check, refuse', () => {
  const call = (c: string, sub: string, text: string, params: unknown[], role: 'app_user' | 'platform_admin' = 'app_user') =>
    asRole(pool, role, c, { sub }, (cl) => cl.query(text, params), true);

  it('a manager deactivating the owner rule (RB001) — the rule stays active', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(call(f.c, u.m, 'SELECT * FROM approval_rule_update($1,$2,$3,NULL,NULL,NULL,NULL,NULL,false)',
      [f.c, f.ownerRule, u.m]))).toBe('RB001');
    expect((await rule(f.ownerRule)).is_active).toBe(true);
  });

  it('a manager switching the gate off under an owner rule (RB011) — the switch stays', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(call(f.c, u.m, 'SELECT * FROM approval_enforcement_set($1,$2,false,$3)',
      [f.c, 'supplier_invoice', u.m]))).toBe('RB011');
    expect(await switches(f.c)).toEqual(['supplier_invoice']);
  });

  it('an actor who is not the session user, or a company that is not the session company (RB020)', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    const other = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(call(f.c, u.m, 'SELECT * FROM approval_enforcement_set($1,$2,false,$3)',
      [f.c, 'supplier_invoice', u.a]))).toBe('RB020');
    expect(await outcome(call(f.c, u.a, 'SELECT * FROM approval_enforcement_set($1,$2,false,$3)',
      [other.c, 'supplier_invoice', u.a]))).toBe('RB020');
    expect(await switches(other.c)).toEqual(['supplier_invoice']);
  });

  it('a role outside the routes\' write gate (RA008), even creating a rule they may demand', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(call(f.c, u.v, 'SELECT * FROM approval_rule_create($1,$2,$3,$4,NULL,$5,0,$6)',
      [f.c, u.v, 'viewer rule', 'supplier_invoice', 'any', 'viewer']))).toBe('RA008');
  });

  it('platform_admin, which may not execute them at all', async () => {
    const f = await pendingBill(pool, tokens, u, companies);
    expect(await outcome(call(f.c, u.a, 'SELECT * FROM approval_enforcement_set($1,$2,false,$3)',
      [f.c, 'supplier_invoice', u.a], 'platform_admin'))).toBe(DENIED);
    expect(await switches(f.c)).toEqual(['supplier_invoice']);
  });
});
