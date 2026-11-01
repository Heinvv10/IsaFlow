/**
 * Salary on create through the real route (withAuth chain, owner), against a real Postgres: one request, one employee,
 * one component row. A refusal leaves no employee behind (a 4xx COMMITs, so the check has to come before the insert),
 * and a failure after the insert rolls the employee back.
 *
 * The first-month behaviour is PINNED here, not endorsed. calculatePayrollRun reads components on
 * `new Date(year, month - 1, 28)` (payrollRunService.ts:137) and
 * getEmployeeComponents turns that into a date with toISOString() (payrollComponentService.ts:34), so in SAST the read
 * date is the 27th. A start up to the 27th gets the whole month's salary, with no part-month reduction; a start from
 * the 28th is on the run with no salary. The gate runs in SAST (ci.yml TZ); the pins state that first. The form warns
 * of both (firstMonthNotes). Changing the engine's behaviour belongs to W3.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employees from '../../pages/api/payroll/employees';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import * as componentService from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import * as employeeService from '@/modules/accounting/services/payroll/payrollEmployeeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const owner = crypto.randomUUID();
const SALARY_CENTS = 2_500_000;
const SALARY_RANDS = 25_000;
let call: ReturnType<typeof routeCaller>;
let basic = '';
let foreign = '';
let annual = '';
let untaxed = '';

const component = async (companyId: string, name: string, code: string, taxable = true) =>
  (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1,$2,$3,'earning',$4) RETURNING id`, [companyId, name, code, taxable])).rows[0]!.id;

beforeAll(async () => {
  for (const [id, name] of [[company, 'Pay on create'], [other, 'Pay on create other']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  // A member of both, like an accountant: RLS lets them see the other company's component, so only the service's
  // company_id predicate keeps it out of this company's payroll.
  for (const id of [company, other]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
  const token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [owner]: token }, { user: owner, company });
  basic = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [company])).rows[0]!.id;
  foreign = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [other])).rows[0]!.id;
  annual = await component(company, 'Annual bonus', '3605');
  untaxed = await component(company, 'Untaxed wage', '3601', false);
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

const post = (body: Record<string, unknown>) => call(employees as Route, 'POST', '/api/payroll/employees', undefined, { body });
const body = (employeeNumber: string, startDate: string, salary?: unknown) => ({
  firstName: 'Thandi', lastName: 'Nkosi', employeeNumber, employmentType: 'permanent', startDate, ...(salary ? { salary } : {}),
});
const employeeRows = async (employeeNumber: string) => (await pool.query<{ id: string }>(
  'SELECT id FROM payroll_employees WHERE company_id = $1 AND employee_number = $2', [company, employeeNumber])).rows;
const componentRows = async (employeeId: string) => (await pool.query(
  `SELECT component_id, amount::text AS amount, effective_from::text AS effective_from, effective_to, is_recurring
     FROM payroll_employee_components WHERE employee_id = $1`, [employeeId])).rows;
const startDateOf = async (employeeId: string) => (await pool.query<{ start_date: string }>(
  'SELECT start_date::text AS start_date FROM payroll_employees WHERE id = $1', [employeeId])).rows[0]!.start_date;

async function november(employeeId: string) {
  const made = await call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 11, year: 2026 } });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  const done = await call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
  const line = (await pool.query<{ gross_pay: string }>(
    'SELECT gross_pay FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [id, employeeId])).rows;
  await pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [id]);
  await pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [id]);
  return line;
}

describe('POST /api/payroll/employees with a salary', () => {
  it('one employee and one recurring component row, in rands, from the start date', async () => {
    const out = await post(body('WP-1', '2026-11-01', { componentId: basic, amountCents: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const rows = await employeeRows('WP-1');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toEqual([{
      component_id: basic, amount: '25000.00', effective_from: '2026-11-01', effective_to: null, is_recurring: true,
    }]);
    // Two writers, two date conversions: the employee and the salary must land on the same day.
    expect(await startDateOf(rows[0]!.id)).toBe('2026-11-01');
  });

  it('without a salary: an employee and no component row, as before', async () => {
    const out = await post(body('WP-2', '2026-11-01'));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const rows = await employeeRows('WP-2');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toEqual([]);
  });

  it("another company's component: 400 and no employee row", async () => {
    const out = await post(body('WP-3', '2026-11-01', { componentId: foreign, amountCents: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-3')).toEqual([]);
  });

  it('an annual-payment component: 400 and no employee row', async () => {
    const out = await post(body('WP-4', '2026-11-01', { componentId: annual, amountCents: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-4')).toEqual([]);
  });

  it('a bad tax number: 400 and no employee row', async () => {
    const out = await post({ ...body('WP-5', '2026-11-01'), taxNumber: '4123456789' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-5')).toEqual([]);
  });

  it('an employee number already in use: 400 and the first employee keeps its one salary', async () => {
    const first = await post(body('WP-6', '2026-11-01', { componentId: basic, amountCents: SALARY_CENTS }));
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const again = await post(body('WP-6', '2026-12-01', { componentId: basic, amountCents: 100 }));
    expect(again.statusCode, JSON.stringify(again.body)).toBe(400);
    const rows = await employeeRows('WP-6');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toHaveLength(1);
  });

  it('a failure after the employee insert rolls the employee back (same request transaction)', async () => {
    const assign = vi.spyOn(componentService, 'assignComponentToEmployee').mockRejectedValueOnce(new Error('assignment failed'));
    const out = await post(body('WP-7', '2026-11-01', { componentId: basic, amountCents: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(500);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(await employeeRows('WP-7')).toEqual([]);
  });

  it('a salary in `amount` (rands, as the components route takes it): 400 and no employee row', async () => {
    const out = await post(body('WP-10', '2026-11-01', { componentId: basic, amount: SALARY_RANDS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/amountCents/);
    expect(await employeeRows('WP-10')).toEqual([]);
  });

  it('a non-taxable component: 400 and no employee row', async () => {
    const out = await post(body('WP-11', '2026-11-01', { componentId: untaxed, amountCents: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-11')).toEqual([]);
  });

  it('an end date before the start date: 400 and no employee row', async () => {
    const out = await post({ ...body('WP-12', '2026-11-01'), endDate: '2026-10-31' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-12')).toEqual([]);
  });

  it('losing the race for an employee number: 400, the winner stands, no salary, and the request still commits', async () => {
    const real = employeeService.createPayrollEmployee;
    const insert = vi.spyOn(employeeService, 'createPayrollEmployee').mockImplementationOnce(async (companyId, data) => {
      // Past the pre-check, before this request's insert: a real 23505 from a real committed row.
      await pool.query(
        `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
         VALUES ($1, 'WP-13', 'Winner', 'Row', '2026-11-01')`, [company]);
      return real(companyId, data);
    });
    const out = await post(body('WP-13', '2026-11-01', { componentId: basic, amountCents: SALARY_CENTS }));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/already in use/i);
    const rows = await employeeRows('WP-13');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toEqual([]);
  });
});

describe('the first run (PINNED, not endorsed: payrollRunService day 28, read through toISOString)', () => {
  it('the gate reads the components on the 27th, which is why the line below falls between the 27th and the 28th', () => {
    expect(new Date(2026, 10, 28).toISOString().slice(0, 10)).toBe('2026-11-27');
  });

  it.each([
    ['1 Nov, the whole month', 'WP-8', '2026-11-01', SALARY_RANDS],
    ['15 Nov, still the whole month: no part-month reduction', 'WP-14', '2026-11-15', SALARY_RANDS],
    ['27 Nov, the last day that is paid, and in full', 'WP-15', '2026-11-27', SALARY_RANDS],
    ['28 Nov, on the run with gross 0', 'WP-16', '2026-11-28', 0],
    ['29 Nov, on the run with gross 0', 'WP-9', '2026-11-29', 0],
  ])("start %s", async (_n, number, startDate, gross) => {
    const out = await post(body(number, startDate, { componentId: basic, amountCents: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const [row] = await employeeRows(number);
    const line = await november(row!.id);
    expect(line).toHaveLength(1);
    expect(Number(line[0]!.gross_pay)).toBe(gross);
  });
});
