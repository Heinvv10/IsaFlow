/**
 * Employee work terms (mig 967) through the real routes (withAuth chain), against a real Postgres: tax status, pay
 * basis, hours, rates and occupation are stored, a refused body changes no row (a 4xx COMMITs, so the judgement
 * comes before the first write), another company's employee is a 404, a viewer cannot write, every answer is no-store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employees from '../../pages/api/payroll/employees';
import employee from '../../pages/api/payroll/employees/[id]';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const owner = crypto.randomUUID();
const viewer = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let tokens: Record<string, string> = {};
let mine = '';
let foreign = '';

const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

beforeAll(async () => {
  for (const [id, name] of [[company, 'Terms co'], [other, 'Terms other']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  for (const [id, role] of [[owner, 'admin'], [viewer, 'user']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)", [id, `${id}@test.local`, role]);
  }
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [company, viewer]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [other, owner]);
  tokens = { [owner]: await sign(owner), [viewer]: await sign(viewer) };
  call = routeCaller(tokens, { user: owner, company });
  const ids = async (c: string) => (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1 LIMIT 1', [c])).rows[0]!.id;
  mine = await ids(company);
  foreign = await ids(other);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, viewer]]);
  } finally { await pool.end(); }
});

const terms = async (id: string) => (await pool.query(
  `SELECT tax_status, pay_basis, hours_per_week::float AS hpw, hours_per_day::float AS hpd, hourly_rate::float AS hr,
          daily_rate::float AS dr, occupation FROM payroll_employees WHERE id = $1`, [id])).rows[0];
const patch = (id: string, body: Record<string, unknown>, extra: { company?: string; user?: string } = {}) =>
  call(employee as Route, 'PATCH', `/api/payroll/employees/${id}`, id, { body, ...extra });

describe('employee work terms', () => {
  it('a new employee defaults to employee / monthly with no hours, rates or occupation', async () => {
    expect(await terms(mine)).toEqual({ tax_status: 'employee', pay_basis: 'monthly', hpw: null, hpd: null, hr: null, dr: null, occupation: null });
  });

  it('PATCH stores the terms and answers them back; a blank clears an optional one', async () => {
    const out = await patch(mine, { taxStatus: 'director', payBasis: 'hourly', hoursPerWeek: 40, hoursPerDay: 8, hourlyRate: 185.5, occupation: ' Welder ' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(out.body.data).toMatchObject({ taxStatus: 'director', payBasis: 'hourly', hoursPerWeek: 40, hourlyRate: 185.5, occupation: 'Welder' });
    expect(await terms(mine)).toEqual({ tax_status: 'director', pay_basis: 'hourly', hpw: 40, hpd: 8, hr: 185.5, dr: null, occupation: 'Welder' });
    const cleared = await patch(mine, { hoursPerDay: null, occupation: '' });
    expect(cleared.statusCode).toBe(200);
    expect((await terms(mine)).hpd).toBeNull();
    expect((await terms(mine)).occupation).toBeNull();
  });

  it('records each moved term in the employee history', async () => {
    const rows = (await pool.query("SELECT field_name FROM payroll_employee_history WHERE employee_id = $1 AND field_name IN ('tax_status','pay_basis')", [mine])).rows;
    expect(rows.map(r => r.field_name).sort()).toEqual(['pay_basis', 'tax_status']);
  });

  it('a refused body (hours 200) is a 400 and changes no row, even a valid sibling field', async () => {
    const before = await terms(mine);
    const out = await patch(mine, { taxStatus: 'independent_contractor', hoursPerWeek: 200 });
    expect(out.statusCode).toBe(400);
    expect(await terms(mine)).toEqual(before);
  });

  it.each([
    [{ taxStatus: 'boss' }], [{ payBasis: 'weekly' }], [{ hoursPerDay: 25 }], [{ hourlyRate: -1 }], [{ dailyRate: 'lots' }],
    [{ hourlyRate: 10.123 }], [{ occupation: 'x'.repeat(101) }], [{ taxStatus: '' }],
  ])('refuses %j with a 400', async (body) => {
    const before = await terms(mine);
    expect((await patch(mine, body)).statusCode).toBe(400);
    expect(await terms(mine)).toEqual(before);
  });

  it("another company's employee is a 404 and untouched", async () => {
    const before = await terms(foreign);
    expect((await patch(foreign, { taxStatus: 'director' })).statusCode).toBe(404);
    expect(await terms(foreign)).toEqual(before);
  });

  it('a viewer cannot write (403) and reads names only', async () => {
    const before = await terms(mine);
    expect((await patch(mine, { taxStatus: 'employee' }, { user: viewer })).statusCode).toBe(403);
    expect(await terms(mine)).toEqual(before);
    const read = await call(employee as Route, 'GET', `/api/payroll/employees/${mine}`, mine, { user: viewer });
    expect(read.statusCode).toBe(200);
    expect(read.body.data).not.toHaveProperty('taxStatus');
    expect(read.body.data).not.toHaveProperty('hourlyRate');
  });

  it('create takes the terms; a refused term creates no employee', async () => {
    const base = { firstName: 'Sipho', lastName: 'Dube', employmentType: 'contract', startDate: '2026-11-01' };
    const ok = await call(employees as Route, 'POST', '/api/payroll/employees', undefined, {
      body: { ...base, employeeNumber: 'TS-1', taxStatus: 'independent_contractor', payBasis: 'daily', dailyRate: 900, occupation: 'Driver' },
    });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
    expect(await terms(String(ok.body.data!.id))).toMatchObject({ tax_status: 'independent_contractor', pay_basis: 'daily', dr: 900, occupation: 'Driver' });
    const bad = await call(employees as Route, 'POST', '/api/payroll/employees', undefined, { body: { ...base, employeeNumber: 'TS-2', hoursPerWeek: 200 } });
    expect(bad.statusCode).toBe(400);
    expect((await pool.query("SELECT 1 FROM payroll_employees WHERE company_id = $1 AND employee_number = 'TS-2'", [company])).rowCount).toBe(0);
  });

  it('every answer carries Cache-Control: no-store', async () => {
    const jar = { 'sb-access-token': tokens[owner]!, active_company_id: company };
    const get = request(jar, 'GET') as never as { url: string; query: Record<string, unknown> };
    get.query = { id: mine };
    get.url = `/api/payroll/employees/${mine}`;
    const a = response();
    await (employee as Route)(get as never, a.res as never);
    const list = request(jar, 'GET') as never as { url: string; query: Record<string, unknown> };
    list.query = {};
    list.url = '/api/payroll/employees';
    const b = response();
    await (employees as Route)(list as never, b.res as never);
    expect(a.headers.get('cache-control')).toBe('no-store');
    expect(b.headers.get('cache-control')).toBe('no-store');
  });
});
