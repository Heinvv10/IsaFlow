/**
 * Employee work terms (mig 967) through the real routes (withAuth chain), against a real Postgres: tax status, pay
 * basis, hours, rates and occupation are stored, a refused body changes no row (a 4xx COMMITs, so the judgement
 * comes before the first write), another company's employee is a 404, a viewer cannot write, every answer is no-store.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employees from '../../pages/api/payroll/employees';
import employee from '../../pages/api/payroll/employees/[id]';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const owner = crypto.randomUUID();
const viewer = crypto.randomUUID();
const manager = crypto.randomUUID();
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
  for (const [id, role] of [[owner, 'admin'], [viewer, 'viewer'], [manager, 'accountant']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,$3,true)", [id, `${id}@test.local`, role]);
  }
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [company, viewer]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [company, manager]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [other, owner]);
  tokens = { [owner]: await sign(owner), [viewer]: await sign(viewer), [manager]: await sign(manager) };
  call = routeCaller(tokens, { user: owner, company });
  const ids = async (c: string) => (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1 LIMIT 1', [c])).rows[0]!.id;
  mine = await ids(company);
  foreign = await ids(other);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, viewer, manager]]);
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

  it('records every moved term in the employee history, numbers and occupation included', async () => {
    const rows = (await pool.query("SELECT field_name, old_value, new_value FROM payroll_employee_history WHERE employee_id = $1 ORDER BY field_name", [mine])).rows;
    expect(rows).toEqual(expect.arrayContaining([
      { field_name: 'tax_status', old_value: 'employee', new_value: 'director' },
      { field_name: 'pay_basis', old_value: 'monthly', new_value: 'hourly' },
      { field_name: 'hours_per_week', old_value: null, new_value: '40' },
      { field_name: 'hours_per_day', old_value: null, new_value: '8' },
      { field_name: 'hourly_rate', old_value: null, new_value: '185.5' },
      { field_name: 'occupation', old_value: null, new_value: 'Welder' },
    ]));
  });

  it('a PATCH of firstName alone leaves every term intact', async () => {
    const before = await terms(mine);
    expect((await patch(mine, { firstName: 'Renamed' })).statusCode).toBe(200);
    expect(await terms(mine)).toEqual(before);
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
    [{ hourlyRate: null }], [{ payBasis: 'daily' }], [{ hoursPerDay: 60, hoursPerWeek: 40 }],
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

  it('the service itself refuses the wrong company: no row, no history (both company filters)', async () => {
    const before = await terms(foreign);
    const historyBefore = (await pool.query('SELECT count(*)::int AS n FROM payroll_employee_history WHERE employee_id = $1', [foreign])).rows[0].n;
    expect(await updatePayrollEmployee(foreign, company, { occupation: 'Intruder', taxStatus: 'director' }, owner)).toBeNull();
    expect(await terms(foreign)).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS n FROM payroll_employee_history WHERE employee_id = $1', [foreign])).rows[0].n).toBe(historyBefore);
  });

  it('a manager may change the occupation but not the status or a rate (403, nothing written)', async () => {
    const before = await terms(mine);
    expect((await patch(mine, { taxStatus: 'employee' }, { user: manager })).statusCode).toBe(403);
    expect((await patch(mine, { hourlyRate: 1 }, { user: manager })).statusCode).toBe(403);
    expect(await terms(mine)).toEqual(before);
    expect((await patch(mine, { occupation: 'Fitter' }, { user: manager })).statusCode).toBe(200);
    expect((await terms(mine)).occupation).toBe('Fitter');
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

  it('every answer carries Cache-Control: no-store: GET, list, POST, PATCH, and the 4xx refusals', async () => {
    const jar = (user: string) => ({ 'sb-access-token': tokens[user]!, active_company_id: company });
    const run = async (route: Route, method: string, url: string, query: Record<string, unknown>, body?: unknown, user = owner) => {
      const req = request(jar(user), method) as never as { url: string; query: Record<string, unknown>; body: unknown };
      req.query = query;
      req.url = url;
      req.body = body;
      const r = response();
      await route(req as never, r.res as never);
      return r;
    };
    const answers = [
      await run(employee as Route, 'GET', `/api/payroll/employees/${mine}`, { id: mine }),
      await run(employees as Route, 'GET', '/api/payroll/employees', {}),
      await run(employee as Route, 'PATCH', `/api/payroll/employees/${mine}`, { id: mine }, { occupation: 'Rigger' }),
      await run(employee as Route, 'PATCH', `/api/payroll/employees/${mine}`, { id: mine }, { hoursPerWeek: 999 }),
      await run(employee as Route, 'PATCH', `/api/payroll/employees/${mine}`, { id: mine }, { hourlyRate: 5 }, manager),
      await run(employees as Route, 'POST', '/api/payroll/employees', {}, { firstName: 'N', lastName: 'S', employeeNumber: 'TS-NS', employmentType: 'permanent', startDate: '2026-11-01' }),
      await run(employees as Route, 'POST', '/api/payroll/employees', {}, { firstName: 'N', employeeNumber: 'TS-NS2', employmentType: 'permanent', startDate: '2026-11-01' }),
    ];
    expect(answers.map(a => a.state.statusCode)).toEqual([200, 200, 200, 400, 403, 201, 400]);
    for (const a of answers) expect(a.headers.get('cache-control')).toBe('no-store');
  });
});

describe('migration 967: CHECKs and the director backfill', () => {
  const insert = (n: string, extra: string, vals: unknown[] = []) => pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, employment_type, start_date ${extra ? ', ' + extra.split('|')[0] : ''})
     VALUES ($1, $2, 'C', 'K', 'permanent', '2026-01-01' ${extra ? ', ' + extra.split('|')[1] : ''})`, [company, n, ...vals]);

  it.each([
    ['hourly with no rate', "pay_basis|'hourly'"], ['hourly with rate 0', "pay_basis, hourly_rate|'hourly', 0"],
    ['daily with no rate', "pay_basis|'daily'"], ['a day longer than the week', 'hours_per_week, hours_per_day|8, 9'],
    ['an unknown tax status', "tax_status|'boss'"], ['an unknown pay basis', "pay_basis|'weekly'"], ['hours over 168', 'hours_per_week|169'],
    ['hours a day over 24', 'hours_per_day|25'], ['a negative hourly rate', 'hourly_rate|-1'], ['a negative daily rate', 'daily_rate|-1'],
    ['an occupation over 100 characters', "occupation|repeat('x', 101)"],
  ])('the database refuses %s', async (name, extra) => {
    await expect(insert(`CK-${Math.random().toString(36).slice(2, 9)}`, extra)).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts hourly with a rate and a monthly employee carrying hours', async () => {
    await insert('CK-OK1', "pay_basis, hourly_rate|'hourly', 90");
    await insert('CK-OK2', 'hours_per_week, hours_per_day|40, 8');
  });

  it('a component quantity needs its unit, and both are above 0 / in hour|day', async () => {
    const empId = (await pool.query<{ id: string }>("SELECT id FROM payroll_employees WHERE employee_number = 'CK-OK1' AND company_id = $1", [company])).rows[0]!.id;
    const comp = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 LIMIT 1", [company])).rows[0]!.id;
    const put = (q: string, u: string) => pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, quantity, quantity_unit) VALUES ($1,$2,1,'2026-01-01',${q},${u})`, [empId, comp]);
    await expect(put('8', 'NULL')).rejects.toMatchObject({ code: '23514' });
    await expect(put('NULL', "'hour'")).rejects.toMatchObject({ code: '23514' });
    await expect(put('0', "'hour'")).rejects.toMatchObject({ code: '23514' });
    await expect(put('8', "'week'")).rejects.toMatchObject({ code: '23514' });
    await put('8', "'hour'");
    await put('NULL', 'NULL');
  });

  it('the backfill turns director employment types into the director tax status and nothing else', async () => {
    await insert('BF-DIR', '');
    await insert('BF-PERM', '');
    await insert('BF-DIR-CONTRACTOR', "tax_status|'independent_contractor'");
    await pool.query("UPDATE payroll_employees SET employment_type = 'director' WHERE employee_number IN ('BF-DIR', 'BF-DIR-CONTRACTOR') AND company_id = $1", [company]);
    await pool.query(readFileSync('scripts/migrations/sql/967_payroll_employee_work_terms.sql', 'utf8'));
    const status = async (n: string) => (await pool.query<{ tax_status: string }>('SELECT tax_status FROM payroll_employees WHERE employee_number = $1 AND company_id = $2', [n, company])).rows[0]!.tax_status;
    expect(await status('BF-DIR')).toBe('director');
    expect(await status('BF-PERM')).toBe('employee');
    expect(await status('BF-DIR-CONTRACTOR')).toBe('independent_contractor');
  });
});
