/**
 * Salary on create through the real route (withAuth chain, owner), against a real Postgres: one request, one employee,
 * one component row. A refusal leaves no employee behind (a 4xx COMMITs, so the check has to come before the insert),
 * and a failure after the insert rolls the employee back.
 *
 * The first-month behaviour is PINNED here, not endorsed. calculatePayrollRun reads components on
 * `new Date(year, month - 1, 28)` (payrollRunService.ts:137) and
 * getEmployeeComponents turns that into a date with toISOString() (payrollComponentService.ts:34), so in SAST the read
 * date is the 27th. Someone starting on the 28th to the 31st is on the run with no salary. Mid-month starts belong to W3.
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

const component = async (companyId: string, name: string, code: string, type = 'earning', active = true) =>
  (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_active)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [companyId, name, code, type, active])).rows[0]!.id;

beforeAll(async () => {
  for (const [id, name] of [[company, 'Pay on create'], [other, 'Pay on create other']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  const token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [owner]: token }, { user: owner, company });
  basic = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [company])).rows[0]!.id;
  foreign = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [other])).rows[0]!.id;
  annual = await component(company, 'Annual bonus', '3605');
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
    const out = await post(body('WP-1', '2026-11-01', { componentId: basic, amount: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const rows = await employeeRows('WP-1');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toEqual([{
      component_id: basic, amount: '25000.00', effective_from: '2026-11-01', effective_to: null, is_recurring: true,
    }]);
  });

  it('without a salary: an employee and no component row, as before', async () => {
    const out = await post(body('WP-2', '2026-11-01'));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const rows = await employeeRows('WP-2');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toEqual([]);
  });

  it("another company's component: 400 and no employee row", async () => {
    const out = await post(body('WP-3', '2026-11-01', { componentId: foreign, amount: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-3')).toEqual([]);
  });

  it('an annual-payment component: 400 and no employee row', async () => {
    const out = await post(body('WP-4', '2026-11-01', { componentId: annual, amount: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-4')).toEqual([]);
  });

  it('a bad tax number: 400 and no employee row', async () => {
    const out = await post({ ...body('WP-5', '2026-11-01'), taxNumber: '4123456789' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await employeeRows('WP-5')).toEqual([]);
  });

  it('an employee number already in use: 400 and the first employee keeps its one salary', async () => {
    const first = await post(body('WP-6', '2026-11-01', { componentId: basic, amount: SALARY_CENTS }));
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    const again = await post(body('WP-6', '2026-12-01', { componentId: basic, amount: 100 }));
    expect(again.statusCode, JSON.stringify(again.body)).toBe(400);
    const rows = await employeeRows('WP-6');
    expect(rows).toHaveLength(1);
    expect(await componentRows(rows[0]!.id)).toHaveLength(1);
  });

  it('a failure after the employee insert rolls the employee back (same request transaction)', async () => {
    vi.spyOn(componentService, 'assignComponentToEmployee').mockRejectedValueOnce(new Error('assignment failed'));
    await post(body('WP-7', '2026-11-01', { componentId: basic, amount: SALARY_CENTS })).catch(() => undefined);
    expect(await employeeRows('WP-7')).toEqual([]);
  });
});

describe('the first run', () => {
  it("start 1 Nov: the Nov run's gross is the salary", async () => {
    const out = await post(body('WP-8', '2026-11-01', { componentId: basic, amount: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const [row] = await employeeRows('WP-8');
    const line = await november(row!.id);
    expect(line).toHaveLength(1);
    expect(Number(line[0]!.gross_pay)).toBe(SALARY_RANDS);
  });

  it('start 29 Nov: PINNED, the Nov run has a line with gross 0 (payrollRunService day 28, toISOString)', async () => {
    const out = await post(body('WP-9', '2026-11-29', { componentId: basic, amount: SALARY_CENTS }));
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const [row] = await employeeRows('WP-9');
    const line = await november(row!.id);
    expect(line).toHaveLength(1);
    expect(Number(line[0]!.gross_pay)).toBe(0);
  });
});
