/**
 * Edit dates judges paid months company-wide, as assign, batch and package do (security finding, 2026-11-03): a
 * once-off moved into a month an approved run already read, or a recurring row stretched back into one, is refused
 * even for an employee who is not on that run, since that run will never pay it.
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
let outsider = '';
const row: Record<string, string> = {};

const patch = (aid: string, body: unknown) =>
  call(components as Route, 'PATCH', `/api/payroll/employees/${outsider}/components?aid=${aid}`, outsider, { body, query: { aid } });
const datesOf = async (id: string) => (await pool.query(
  "SELECT to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [id])).rows[0];

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Edit dates outsider']);
  const salary = await seedPayrollCompany(pool, company);
  const first = String((await pool.query('SELECT employee_id, component_id FROM payroll_employee_components WHERE id=$1', [salary])).rows[0]!.component_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  const bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [bonus, company]);

  // February is approved with the seeded employee only; the outsider is added after, so has no line on that run.
  const feb = await calculatedRun(call, 2);
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${feb}/journal-plan`, feb);
  const approved = await call(approve as Route, 'POST', `/api/payroll/runs/${feb}/approve`, feb, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);

  outsider = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,'OUT-1','Out','Sider','2020-01-01','active',false)`, [outsider, company]);
  for (const [key, component, from, to, recurring] of [
    ['onceOff', bonus, '2026-04-10', '2026-04-30', false],
    ['recurring', first, '2026-03-01', null, true],
  ] as const) {
    row[key] = String((await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,700,$3::date,$4::date,$5) RETURNING id`, [outsider, component, from, to, recurring])).rows[0]!.id);
  }
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('an employee who is not on the approved run', () => {
  it('a once-off moved into the paid month is refused, nothing written', async () => {
    const before = await datesOf(row.onceOff!);
    const out = await patch(row.onceOff!, { effectiveFrom: '2026-02-10', effectiveTo: '2026-02-20' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/2026-02 .*already paid/i);
    expect(await datesOf(row.onceOff!)).toEqual(before);
  });

  it('a recurring row stretched back into the paid month is refused, nothing written', async () => {
    const before = await datesOf(row.recurring!);
    const out = await patch(row.recurring!, { effectiveFrom: '2026-01-01', effectiveTo: null });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/2026-02 .*already paid/i);
    expect(await datesOf(row.recurring!)).toEqual(before);
  });

  it('edits that add no paid month are accepted', async () => {
    expect((await patch(row.onceOff!, { effectiveFrom: '2026-04-15', effectiveTo: '2026-04-30' })).statusCode).toBe(200);
    expect((await patch(row.recurring!, { effectiveFrom: '2026-03-15', effectiveTo: null })).statusCode).toBe(200);
  });
});
