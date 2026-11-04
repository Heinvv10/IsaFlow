/**
 * Editing an assignment's dates (PATCH /api/payroll/employees/:id/components?aid=…, the profile card's "Edit dates"):
 * effective_from and effective_to, on open and ended rows, scoped to the company like assign and end. This is how a run
 * refused for a manual pro-rata (payrollRecurringProRata) is cleared: the recurring salary moved to the 1st of next
 * month, the part month captured as a once-off, the run recalculated. Real routes, withAuth, disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let salary = '';
let bonus = '';
let starter = '';
let foreignRow = '';

const url = (employee: string, aid?: string) => `/api/payroll/employees/${employee}/components${aid ? `?aid=${aid}` : ''}`;
async function patch(employee: string, aid: string, body: unknown) {
  return call(components as Route, 'PATCH', url(employee, aid), employee, { body, query: { aid } });
}
async function rowsOf(employee: string) {
  return (await pool.query(
    "SELECT id, amount::float8 AS amount, to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t, is_recurring FROM payroll_employee_components WHERE employee_id=$1 ORDER BY effective_from",
    [employee])).rows as Array<{ id: string; amount: number; f: string; t: string | null; is_recurring: boolean }>;
}
async function blocker(run: string) {
  const out = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run);
  expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  return (out.body.data as { blocker: { code: string; detail: string } | null }).blocker;
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'Edit dates'], [other, 'Edit dates other tenant']]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  foreignRow = String((await pool.query(
    'SELECT pec.id FROM payroll_employee_components pec JOIN payroll_employees e ON e.id=pec.employee_id WHERE e.company_id=$1', [other])).rows[0]!.id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  salary = String((await pool.query('SELECT id FROM payroll_components WHERE company_id=$1', [company])).rows[0]!.id);
  bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Part-month salary','3601','earning')", [bonus, company]);
  starter = String((await pool.query(
    `INSERT INTO payroll_employees(company_id,employee_number,first_name,last_name,start_date,date_of_birth,tax_number,medical_aid_main_member)
     VALUES($1,'ED-START30','Late','Starter','2026-03-30','1990-01-01','0123456780',false) RETURNING id`, [company])).rows[0]!.id);
  const assigned = await call(components as Route, 'POST', url(starter), starter,
    { body: { componentId: salary, amount: 31000, effectiveFrom: '2026-03-30', isRecurring: true } });
  expect(assigned.statusCode, JSON.stringify(assigned.body)).toBe(201);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('editing dates refuses what assign and end refuse', () => {
  it.each([
    ['a missing effectiveFrom', { effectiveTo: '2026-04-30' }],
    ['a date that is not a calendar date', { effectiveFrom: '2026-02-30', effectiveTo: null }],
    ['an end before the start', { effectiveFrom: '2026-04-10', effectiveTo: '2026-04-09' }],
  ])('%s: 400, nothing changed', async (_n, body) => {
    const [row] = await rowsOf(starter);
    expect((await patch(starter, row!.id, body)).statusCode).toBe(400);
    expect(await rowsOf(starter)).toEqual([row]);
  });

  it("another company's assignment: 404, untouched", async () => {
    const before = (await pool.query('SELECT effective_from, effective_to FROM payroll_employee_components WHERE id=$1', [foreignRow])).rows;
    expect((await patch(starter, foreignRow, { effectiveFrom: '2026-01-01', effectiveTo: null })).statusCode).toBe(404);
    expect((await pool.query('SELECT effective_from, effective_to FROM payroll_employee_components WHERE id=$1', [foreignRow])).rows).toEqual(before);
  });

  it('an ended row can be edited, and an end date cleared', async () => {
    const [row] = await rowsOf(starter);
    expect((await call(components as Route, 'DELETE', url(starter, row!.id), starter, { body: { effectiveTo: '2026-03-31' }, query: { aid: row!.id } })).statusCode).toBe(200);
    expect((await rowsOf(starter))[0]!.t).toBe('2026-03-31');
    expect((await patch(starter, row!.id, { effectiveFrom: '2026-03-30', effectiveTo: null })).statusCode).toBe(200);
    expect((await rowsOf(starter))[0]).toMatchObject({ f: '2026-03-30', t: null });
  });
});

describe('a run refused for a manual pro-rata is cleared through the profile and a recalculation', () => {
  it('flagged, dates edited, part month added, recalculated: approvable', async () => {
    const run = await calculatedRun(call, 3);
    expect((await blocker(run))?.code).toBe('recurring_needs_pro_rata');

    const [row] = await rowsOf(starter);
    const edited = await patch(starter, row!.id, { effectiveFrom: '2026-04-01', effectiveTo: null });
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    const partMonth = await call(components as Route, 'POST', url(starter), starter,
      { body: { componentId: bonus, amount: 2000, effectiveFrom: '2026-03-30', isRecurring: false } });
    expect(partMonth.statusCode, JSON.stringify(partMonth.body)).toBe(201);
    expect((await blocker(run))?.detail).toMatch(/recalculate/i); // the run still carries the old figures

    const recalc = await call(calculate as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run);
    expect(recalc.statusCode, JSON.stringify(recalc.body)).toBe(200);
    expect(await blocker(run)).toBeNull();
    const line = (await pool.query('SELECT gross_pay::float8 AS gross FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, starter])).rows[0];
    expect(line.gross).toBe(2000);
  });
});
