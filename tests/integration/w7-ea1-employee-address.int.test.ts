/**
 * Wave 7 EA1 (W5 part 1; migration 1056): an employee's address through the real route, withAuth and Postgres, as
 * app_user, on two tenants.
 *  - owner / admin / manager capture it; a viewer may neither read nor write; Login-as and a token are refused;
 *  - a refused request (invalid, viewer, Login-as, another tenant's employee) changes no row;
 *  - another company's member reaches nothing of this company's employee (404), and the service's own company
 *    predicate holds with RLS out of the way;
 *  - the change history records the address keys and masks them for everyone (last four), nothing in plain text;
 *  - the migration's CHECKs refuse a value longer than its BRS code allows, even written directly.
 * Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import address from '../../pages/api/payroll/employees/[id]/address';
import entityChanges from '../../pages/api/accounting/entity-changes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, reasonOf } from './r035-approval.helpers';
import { dataOf, impersonationToken } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { employee, outsideRls } from './k1-employee-bank-details.helpers';
import { getEmployeeAddress, setEmployeeAddress } from '../../src/modules/accounting/services/payroll/payrollEmployeeAddress';
import type { EntityChangePage } from '../../src/modules/accounting/services/core/entityChanges/entityChangeTypes';
import type { EmployeeAddress } from '../../src/modules/accounting/services/payroll/payrollEmployeeAddressInput';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let o = '', a = '', m = '', v = '', other = '';

const ADDRESS: EmployeeAddress = {
  residential: { unitNumber: '4', complex: 'Oak Court', streetNumber: '12', street: 'Kingfisher Avenue', suburb: 'Hatfield', city: 'Pretoria', postalCode: '0028', countryCode: 'ZA' },
  postal: { sameAsResidential: false, line1: 'PO Box 4711', line2: 'Brooklyn Square', line3: null, line4: null, postalCode: '0075', countryCode: 'ZA' },
};
const CHANGED: EmployeeAddress = {
  residential: { ...ADDRESS.residential, street: 'Heron Crescent', postalCode: '0081' },
  postal: { sameAsResidential: true },
};
const COLS = `residential_unit_number, residential_complex, residential_street_number, residential_street, residential_suburb,
  residential_city, residential_postal_code, residential_country_code, postal_same_as_residential, postal_address_line1,
  postal_address_line2, postal_address_line3, postal_address_line4, postal_address_code, postal_address_country_code`;
const url = (id: string) => `/api/payroll/employees/${id}/address`;
const put = (token: string, c: string, id: string, body: unknown) => callRoute(address, token, c, 'PUT', body, url(id), { id });
const get = (token: string, c: string, id: string) => callRoute(address, token, c, 'GET', undefined, url(id), { id });
const rowOf = async (id: string) => (await pool.query(`SELECT company_id, ${COLS} FROM payroll_employees WHERE id = $1`, [id])).rows[0];

beforeAll(async () => { [o, a, m, v, other] = await members(pool, tokens, 5); });
afterAll(async () => {
  await pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = ANY($1::text[])', [[o, a, m, v, other]]);
  await cleanupEntityChanges(pool, companies, [o, a, m, v, other]);
});

const company = () => newCompany(pool, [[o, 'owner'], [a, 'admin'], [m, 'manager'], [v, 'viewer']], companies);

describe('capture and read', () => {
  it.each(['owner', 'admin', 'manager'])('a %s captures it; GET answers it as stored', async (role) => {
    const c = await company();
    const e = await employee(pool, c);
    const user = { owner: o, admin: a, manager: m }[role]!;
    expect(dataOf(await get(tokens[user]!, c, e))).toBeNull();
    const res = await put(tokens[user]!, c, e, ADDRESS);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf(res)).toEqual(ADDRESS);
    expect(await rowOf(e)).toMatchObject({
      company_id: c, residential_street: 'Kingfisher Avenue', residential_postal_code: '0028', postal_same_as_residential: false,
      postal_address_line1: 'PO Box 4711', postal_address_code: '0075', postal_address_country_code: 'ZA',
    });
    expect(dataOf(await get(tokens[user]!, c, e))).toEqual(ADDRESS);
  });

  it('postal = residential clears the postal lines', async () => {
    const c = await company();
    const e = await employee(pool, c);
    await put(tokens[o]!, c, e, ADDRESS);
    const res = await put(tokens[m]!, c, e, CHANGED);
    expect(dataOf(res)).toEqual(CHANGED);
    expect(await rowOf(e)).toMatchObject({ postal_same_as_residential: true, postal_address_line1: null, postal_address_code: null, postal_address_country_code: null });
  });
});

describe('refused requests change no row', () => {
  it('an address the BRS rules refuse: 422 with the field, nothing written', async () => {
    const c = await company();
    const e = await employee(pool, c);
    await put(tokens[o]!, c, e, ADDRESS);
    const before = await rowOf(e);
    const res = await put(tokens[o]!, c, e, { ...CHANGED, residential: { ...CHANGED.residential, postalCode: '0000' } });
    expect(res.state.statusCode).toBe(422);
    expect(JSON.stringify(res.state.body)).toContain('residential.postalCode');
    expect(await rowOf(e)).toEqual(before);
  });

  it('a viewer may neither read nor write', async () => {
    const c = await company();
    const e = await employee(pool, c);
    await put(tokens[o]!, c, e, ADDRESS);
    const before = await rowOf(e);
    expect((await get(tokens[v]!, c, e)).state.statusCode).toBe(403);
    expect((await put(tokens[v]!, c, e, CHANGED)).state.statusCode).toBe(403);
    expect(await rowOf(e)).toEqual(before);
  });

  it('Login-as is refused both ways, even as the owner; a token too', async () => {
    const c = await company();
    const e = await employee(pool, c);
    await put(tokens[o]!, c, e, ADDRESS);
    const before = await rowOf(e);
    const login = await impersonationToken(pool, o, a);
    for (const res of [await get(login, c, e), await put(login, c, e, CHANGED)]) {
      expect(res.state.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('IMPERSONATION_FORBIDDEN');
    }
    const token = await new SignJWT({ sub: o, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    for (const res of [await get(token, c, e), await put(token, c, e, CHANGED)]) {
      expect(res.state.statusCode).toBe(403);
      expect(reasonOf(res)).toBe('AGENT_FORBIDDEN');
    }
    expect(await rowOf(e)).toEqual(before);
  });
});

describe('two tenants', () => {
  it('another company\'s owner reaches nothing of this employee, through the route or the service', async () => {
    const c = await company();
    const b = await newCompany(pool, [[other, 'owner']], companies);
    const e = await employee(pool, c);
    const eb = await employee(pool, b);
    await put(tokens[o]!, c, e, ADDRESS);
    // 10x the house number, a different street: B's own write lands on B's employee only.
    expect((await put(tokens[other]!, b, eb, { ...CHANGED, residential: { ...CHANGED.residential, streetNumber: '120' } })).state.statusCode).toBe(200);
    const before = await rowOf(e);
    expect((await get(tokens[other]!, b, e)).state.statusCode).toBe(404);
    expect((await put(tokens[other]!, b, e, CHANGED)).state.statusCode).toBe(404);
    // As the fixture's login (RLS bypassed): the service's own company predicate is the tenant check.
    expect(await outsideRls(pool, b, () => getEmployeeAddress(b, e))).toBeUndefined();
    expect(await outsideRls(pool, b, () => setEmployeeAddress(b, e, CHANGED))).toBeUndefined();
    expect(await rowOf(e)).toEqual(before);
    expect((await rowOf(eb)).residential_street_number).toBe('120');
    expect(dataOf(await get(tokens[o]!, c, e))).toEqual(ADDRESS);
  });
});

describe('the change history', () => {
  it('records the address keys and masks them for a manager and an owner; no value in plain text', async () => {
    const c = await company();
    const e = await employee(pool, c);
    await put(tokens[o]!, c, e, ADDRESS);
    await put(tokens[m]!, c, e, CHANGED);
    const recorded = (await changesOf(pool, e)).filter((x) => x.op === 'update');
    expect(recorded.map((x) => x.changed)).toEqual([
      expect.arrayContaining(['residential_street', 'postal_address_line1', 'postal_same_as_residential']),
      expect.arrayContaining(['residential_street', 'residential_postal_code', 'postal_address_line1', 'postal_same_as_residential']),
    ]);
    for (const user of [m, o]) {
      const res = await callRoute(entityChanges, tokens[user]!, c, 'GET', undefined, '/api/accounting/entity-changes',
        { entityType: 'payroll_employee', entityId: e });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
      const { items } = dataOf<EntityChangePage>(res);
      const last = items[0]!;
      expect(last.fields.find((f) => f.key === 'residential_street')).toEqual({ key: 'residential_street', before: '…enue', after: '…cent', masked: true });
      expect(last.fields.find((f) => f.key === 'postal_address_line1')).toEqual({ key: 'postal_address_line1', before: '…4711', after: null, masked: true });
      for (const leak of ['Kingfisher', 'Heron', 'PO Box', 'Brooklyn', 'Hatfield', '0028', '0081', '0075']) {
        expect(JSON.stringify(items), leak).not.toContain(leak);
      }
    }
  });

  it('the same address again records nothing', async () => {
    const c = await company();
    const e = await employee(pool, c);
    await put(tokens[o]!, c, e, ADDRESS);
    const n = (await changesOf(pool, e)).length;
    expect((await put(tokens[o]!, c, e, ADDRESS)).state.statusCode).toBe(200);
    expect((await changesOf(pool, e)).length).toBe(n);
  });
});

describe('migration 1056', () => {
  it('the columns are nullable and a value longer than its BRS code allows is refused by the table', async () => {
    const c = await company();
    const e = await employee(pool, c);
    const { rows } = await pool.query(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payroll_employees' AND (column_name LIKE 'residential\\_%' OR column_name LIKE 'postal\\_%')`);
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.is_nullable === 'YES')).toBe(true);
    for (const [col, value, check] of [
      ['residential_street', 'x'.repeat(27), 'payroll_employees_residential_street_check'],
      ['residential_suburb', 'x'.repeat(34), 'payroll_employees_residential_suburb_check'],
      ['postal_address_line1', 'x'.repeat(36), 'payroll_employees_postal_address_line1_check'],
      ['residential_country_code', 'za', 'payroll_employees_residential_country_code_check'],
    ] as const) {
      await expect(pool.query(`UPDATE payroll_employees SET ${col} = $2 WHERE id = $1`, [e, value]), col).rejects.toThrow(check);
    }
    await pool.query("UPDATE payroll_employees SET residential_street = $2 WHERE id = $1", [e, 'x'.repeat(26)]);
  });
});
