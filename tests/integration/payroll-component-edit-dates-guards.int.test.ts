/**
 * What Edit dates (PATCH /api/payroll/employees/:id/components?aid=…, updateEmployeeComponentDates) refuses, before
 * any write, with the row locked inside the company and the company's payroll-approval lock held (security review,
 * 2026-11-02):
 *   - a once-off left open-ended, or spanning more than one month (it is paid once, in its own month);
 *   - a window overlapping another live row of the same employee and component (both would be paid);
 *   - a voided row (cancelled: assign a new one);
 *   - a change to what an already-paid run paid: a once-off it paid moved, or a recurring row's dates moved into or
 *     out of a paid month (a run approved, paid, or holding a posted journal).
 * An accepted edit is written to the audit trail (audit_log, entity payroll_employee_component) with the dates before
 * and after. End (DELETE) on a once-off no run has paid cancels it (voids it); End on a paid one only ends it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let employee = '';
let otherEmployee = '';
const row: Record<string, string> = {};

const url = (aid: string) => `/api/payroll/employees/${employee}/components?aid=${aid}`;
const patchFor = (employeeId: string, aid: string, body: unknown) => call(
  components as Route, 'PATCH', `/api/payroll/employees/${employeeId}/components?aid=${aid}`,
  employeeId, { body, query: { aid } },
);
const patch = (aid: string, body: unknown) => patchFor(employee, aid, body);
const end = (aid: string, effectiveTo: string) => call(components as Route, 'DELETE', url(aid), employee, { body: { effectiveTo }, query: { aid } });
const datesOf = async (id: string) => (await pool.query(
  "SELECT to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [id])).rows[0];

async function add(key: string, component: string, amount: number, from: string, to: string | null, recurring: boolean) {
  row[key] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,$3,$4::date,$5::date,$6) RETURNING id`, [employee, component, amount, from, to, recurring])).rows[0]!.id);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Edit dates guards']);
  row.salary = await seedPayrollCompany(pool, company);
  employee = String((await pool.query('SELECT employee_id FROM payroll_employee_components WHERE id=$1', [row.salary])).rows[0]!.employee_id);
  otherEmployee = String((await pool.query(
    `INSERT INTO payroll_employees(company_id,employee_number,first_name,last_name,start_date,date_of_birth,tax_number,medical_aid_main_member)
     VALUES($1,'W301-2','Other','Employee','2020-01-01','1981-01-01','9876543210',true) RETURNING id`, [company])).rows[0]!.id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  const bonus = crypto.randomUUID();
  const allowance = crypto.randomUUID();
  for (const [id, name, code] of [[bonus, 'Bonus', '3605'], [allowance, 'Allowance', '3713']]) {
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,$4,'earning')", [id, company, name, code]);
  }
  await add('paidOnceOff', bonus, 1500, '2026-02-10', '2026-02-28', false);
  await add('onceOff', bonus, 700, '2026-04-10', '2026-04-30', false);
  await add('onceOffToEnd', bonus, 300, '2026-05-10', '2026-05-31', false);
  await add('voided', bonus, 900, '2026-04-20', '2026-04-19', false);
  await add('allowanceOld', allowance, 500, '2025-01-01', '2026-03-31', true);
  await add('allowanceNew', allowance, 650, '2026-04-01', null, true);

  // February 2026 approved through the real routes: it paid the salary, the February bonus and the old allowance.
  const feb = await calculatedRun(call, 2);
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${feb}/journal-plan`, feb);
  const approved = await call(approve as Route, 'POST', `/api/payroll/runs/${feb}/approve`, feb, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('refused, nothing written', () => {
  it('an assignment belonging to another employee named in the URL', async () => {
    const before = await datesOf(row.onceOff!);
    const out = await patchFor(otherEmployee, row.onceOff!, { effectiveFrom: '2026-04-15', effectiveTo: '2026-04-30' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(404);
    expect(await datesOf(row.onceOff!)).toEqual(before);
  });

  it.each([
    ['a once-off left open-ended', 'onceOff', { effectiveFrom: '2026-04-10', effectiveTo: null }, /once-off needs an end date/i],
    ['a once-off spanning two months', 'onceOff', { effectiveFrom: '2026-04-10', effectiveTo: '2026-05-05' }, /one month/i],
    ['a window overlapping the next row of the same component', 'allowanceOld', { effectiveFrom: '2025-01-01', effectiveTo: '2026-04-15' }, /overlap the employee's other assignment/i],
    ['a voided row', 'voided', { effectiveFrom: '2026-04-20', effectiveTo: '2026-04-30' }, /cancelled/i],
    ['a once-off an approved run paid, moved', 'paidOnceOff', { effectiveFrom: '2026-03-10', effectiveTo: '2026-03-31' }, /2026-02 .*already paid/i],
    ['a recurring row moved out of a paid month', 'salary', { effectiveFrom: '2026-03-01', effectiveTo: null }, /2026-02 .*already paid/i],
    ['a recurring row ended before a paid month', 'allowanceOld', { effectiveFrom: '2025-01-01', effectiveTo: '2026-01-31' }, /2026-02 .*already paid/i],
  ])('%s', async (_n, key, body, message) => {
    const before = await datesOf(row[key]!);
    const out = await patch(row[key]!, body);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(message);
    expect(await datesOf(row[key]!)).toEqual(before);
  });
});

describe('accepted', () => {
  it('a once-off moved within an unpaid month, recorded in the audit trail with its dates before and after', async () => {
    const out = await patch(row.onceOff!, { effectiveFrom: '2026-04-15', effectiveTo: '2026-04-30' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await datesOf(row.onceOff!)).toEqual({ f: '2026-04-15', t: '2026-04-30' });
    const { rows } = await pool.query(
      "SELECT user_id, action, changes FROM audit_log WHERE company_id=$1 AND entity_type='payroll_employee_component' AND entity_id=$2",
      [company, row.onceOff]);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(admin);
    expect(rows[0].action).toBe('update');
    expect(rows[0].changes.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'effective_from', old: '2026-04-10', new: '2026-04-15' }),
      expect.objectContaining({ field: 'effective_to', old: '2026-04-30', new: '2026-04-30' }),
    ]));
  });

  it('a recurring row whose change touches no paid month', async () => {
    const out = await patch(row.allowanceNew!, { effectiveFrom: '2026-05-01', effectiveTo: null });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    expect(await datesOf(row.allowanceNew!)).toEqual({ f: '2026-05-01', t: null });
  });
});

describe('End', () => {
  it('on a once-off no run has paid: cancelled (voided), whatever end date was sent', async () => {
    expect((await end(row.onceOffToEnd!, '2026-05-20')).statusCode).toBe(200);
    const d = await datesOf(row.onceOffToEnd!);
    expect(d.t < d.f).toBe(true);
  });

  it('on a once-off an approved run paid: only ended, as before', async () => {
    expect((await end(row.paidOnceOff!, '2026-02-20')).statusCode).toBe(200);
    expect(await datesOf(row.paidOnceOff!)).toEqual({ f: '2026-02-10', t: '2026-02-20' });
  });
});
