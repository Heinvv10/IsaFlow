/**
 * Wave 3 K2, the profile card's read: GET ?view=masked answers owner / admin the masked view too (so the page never
 * holds a full number it does not show), and writes no `export` audit row, which a full read does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import entityChanges from '../../pages/api/accounting/entity-changes';
import { SignJWT } from 'jose';
import bankDetails from '../../pages/api/payroll/employees/[id]/bank-details';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { listEntityChanges } from '../../src/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { employee, OTHER, outsideRls, put, ROW, url } from './k1-employee-bank-details.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '', x = '';

beforeAll(async () => { [o, a, m, v, x] = await members(pool, tokens, 5); });
afterAll(async () => {
  await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [companies]);
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [[o, a, m, v, x]]);
  await cleanupEntityChanges(pool, companies, [o, a, m, v, x]);
});

const masked = (user: string, c: string, e: string, view?: string) =>
  callRoute(bankDetails, tokens[user]!, c, 'GET', undefined, url(e), view ? { id: e, view } : { id: e });
/** The full-read audit rows (what auditBankDetailsRead writes), for the detail row `id`. */
const exportAudits = async (c: string, id: string) => (await pool.query(
  `SELECT 1 FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_bank_detail' AND action = 'export' AND entity_id = $2`,
  [c, id])).rowCount;

describe('GET ?view=masked', () => {
  it.each(['owner', 'admin'])('answers %s masked and leaves no audit row; without it the read is full and audited', async (role) => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer'], [x, 'accountant']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const user = role === 'owner' ? o : a;
    const [{ id }] = (await pool.query<{ id: string }>('SELECT id FROM payroll_bank_details WHERE employee_id = $1', [e])).rows as [{ id: string }];

    const res = await masked(user, c, e, 'masked');
    expect(dataOf(res)).toMatchObject({ accountNumber: '…3456', masked: true, branchCode: '…55', accountHolder: 'K…' });
    for (const leak of [ROW.accountNumber, ROW.branchCode, ROW.accountHolder]) expect(JSON.stringify(res.state.body)).not.toContain(leak);
    expect(await exportAudits(c, id)).toBe(0); // before the plain read, after the masked one

    expect(dataOf(await masked(user, c, e))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
    expect(await exportAudits(c, id)).toBe(1);
    await masked(user, c, e, 'masked');
    expect(await exportAudits(c, id)).toBe(1); // a second masked read adds none
  });

  it('a manager gets the same masked view, and no audit row, with or without it', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer'], [x, 'accountant']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const [{ id }] = (await pool.query<{ id: string }>('SELECT id FROM payroll_bank_details WHERE employee_id = $1', [e])).rows as [{ id: string }];
    for (const view of ['masked', undefined]) {
      expect(dataOf(await masked(m, c, e, view))).toMatchObject({ accountNumber: '…3456', masked: true, branchCode: '…55', accountHolder: 'K…' });
      expect(await exportAudits(c, id)).toBe(0);
    }
  });

  it('any other view value is the ordinary read', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer'], [x, 'accountant']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    expect(dataOf(await masked(o, c, e, 'full'))).toMatchObject({ accountNumber: ROW.accountNumber, masked: false });
  });
});

describe('GET /entity-changes?entityType=payroll_bank_detail&employeeId=', () => {
  const byEmployee = (user: string, c: string, query: Record<string, string>) =>
    callRoute(entityChanges, tokens[user]!, c, 'GET', undefined, '/api/accounting/entity-changes', query);
  const afterOf = (res: Awaited<ReturnType<typeof byEmployee>>, key: string) =>
    (dataOf<{ items: Array<{ fields: Array<{ key: string; after: unknown }> }> }>(res).items)
      .flatMap((i) => i.fields.filter((f) => f.key === key).map((f) => f.after));

  it('returns the old and the new account across the retired row, masked, and nothing of another employee', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer'], [x, 'accountant']], companies);
    const e = await employee(pool, c);
    const other = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    expect((await put(tokens[o]!, c, e, OTHER)).state.statusCode).toBe(200);
    expect((await put(tokens[o]!, c, other, { ...ROW, accountNumber: '99887766' })).state.statusCode).toBe(200);

    for (const user of [o, a, m]) {
      const res = await byEmployee(user, c, { entityType: 'payroll_bank_detail', employeeId: e });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      const numbers = afterOf(res, 'account_number');
      expect(numbers).toEqual(expect.arrayContaining(['…3456', '…4680']));
      expect(numbers).not.toContain('…7766');
      expect(afterOf(res, 'account_holder')).toEqual(expect.arrayContaining(['K…']));
      for (const leak of [ROW.accountNumber, OTHER.accountNumber, ROW.branchCode, OTHER.branchCode, ROW.accountHolder]) expect(JSON.stringify(res.state.body)).not.toContain(leak);
    }
  });

  it('an uppercase employee id finds the same history', async () => {
    const c = await newCompany(pool, [[o, 'owner']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const res = await byEmployee(o, c, { entityType: 'payroll_bank_detail', employeeId: e.toUpperCase() });
    expect(afterOf(res, 'account_number')).toEqual(['…3456']);
  });

  it.each([['viewer', () => v], ['accountant', () => x]])('a %s is refused 403 (by the role check, before any query)', async (_r, user) => {
    const c = await newCompany(pool, [[o, 'owner'], [v, 'viewer'], [x, 'accountant']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const res = await byEmployee(user(), c, { entityType: 'payroll_bank_detail', employeeId: e });
    expect(res.state.statusCode).toBe(403);
    expect(JSON.stringify(res.state.body)).not.toContain('…3456');
  });

  it('Login-as and a token are refused on every payroll_bank_detail path, and other types are not', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const [{ id }] = (await pool.query<{ id: string }>('SELECT id FROM payroll_bank_details WHERE employee_id = $1', [e])).rows as [{ id: string }];
    const login = await impersonationToken(pool, o, a);
    const token = await new SignJWT({ sub: o, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const paths = [{ entityType: 'payroll_bank_detail', employeeId: e }, { entityType: 'payroll_bank_detail', entityId: id }, { entityType: 'payroll_bank_detail' }];
    for (const [t, reason] of [[login, 'IMPERSONATION_FORBIDDEN'], [token, 'AGENT_FORBIDDEN']] as const) {
      for (const q of paths) {
        const res = await callRoute(entityChanges, t, c, 'GET', undefined, '/api/accounting/entity-changes', q);
        expect(res.state.statusCode).toBe(403);
        expect(reasonOf(res)).toBe(reason);
      }
      const other = await callRoute(entityChanges, t, c, 'GET', undefined, '/api/accounting/entity-changes', { entityType: 'payroll_employee', entityId: e });
      expect(reasonOf(other)).not.toBe(reason);
    }
  });

  it('the all-types company feed leaves bank-detail rows out for Login-as and a token, keeps them for a person, and keeps other types', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin']], companies);
    const e = await employee(pool, c);
    expect((await put(tokens[o]!, c, e, ROW)).state.statusCode).toBe(200);
    const typesOf = async (t: string) => {
      const res = await callRoute(entityChanges, t, c, 'GET', undefined, '/api/accounting/entity-changes', {});
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      return dataOf<{ items: Array<{ entityType: string }> }>(res).items.map((i) => i.entityType);
    };
    expect(await typesOf(tokens[o]!)).toContain('payroll_bank_detail');
    const login = await impersonationToken(pool, o, a);
    const token = await new SignJWT({ sub: o, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    for (const t of [login, token]) {
      const types = await typesOf(t);
      expect(types).not.toContain('payroll_bank_detail');
      expect(types.length).toBeGreaterThan(0); // the company's other history is still there
    }
  });

  it('is refused (400) without the bank-detail entity type, with another type, or with an entity id', async () => {
    const c = await newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer'], [x, 'accountant']], companies);
    const e = await employee(pool, c);
    expect((await byEmployee(o, c, { employeeId: e })).state.statusCode).toBe(400);
    expect((await byEmployee(o, c, { entityType: 'payroll_employee', employeeId: e })).state.statusCode).toBe(400);
    expect((await byEmployee(o, c, { entityType: 'payroll_bank_detail', employeeId: e, entityId: e })).state.statusCode).toBe(400);
  });

  it("never returns another company's changes for the same employee id, even where RLS does not apply", async () => {
    const c1 = await newCompany(pool, [[o, 'owner']], companies);
    const c2 = await newCompany(pool, [[o, 'owner']], companies);
    const e = await employee(pool, c1);
    expect((await put(tokens[o]!, c1, e, ROW)).state.statusCode).toBe(200);
    // The route's RLS would hide it anyway: run the service as the fixture's login (no RLS) so only the query's own
    // company predicate separates the companies.
    const query = { types: ['payroll_bank_detail'] as const, entityType: 'payroll_bank_detail' as const, employeeId: e, limit: 50 };
    expect((await outsideRls(pool, c1, () => listEntityChanges(c1, query))).items.length).toBeGreaterThan(0);
    expect((await outsideRls(pool, c2, () => listEntityChanges(c2, query))).items).toEqual([]);
  });
});
