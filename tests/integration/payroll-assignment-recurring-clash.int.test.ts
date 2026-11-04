/**
 * What clashes on one employee's component is a recurring row with another recurring row (both would be paid every
 * month). A once-off is additive and may sit on a recurring row of the same component (back pay, a top-up: the reader
 * pays both), so it neither clashes nor blocks. Assign, batch post and Edit dates / End judge it the same way:
 *   - a once-off assigned or edited over a recurring row is accepted;
 *   - End of a recurring row that has a paid once-off sibling is accepted (it was refused for ever);
 *   - a recurring row over a live recurring row is refused;
 *   - a recurring sibling that ended the day before the new start, or is voided (ends before it starts), is no clash;
 *   - the sibling query is scoped to the company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { authorisePayRun, calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { refuseAssignmentWrite } from '@/modules/accounting/services/payroll/payrollAssignmentWriteGuard';
import { withTransaction } from '@/lib/neon';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const admin = crypto.randomUUID();
const actor = { userId: admin, channel: 'rest' as const };
let call: ReturnType<typeof routeCaller>;
let inRun = '';
let hire = '';
const comp: Record<string, string> = {};
const row: Record<string, string> = {};

async function component(key: string, name: string) {
  comp[key] = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3605','earning')", [comp[key], company, name]);
}
async function add(key: string, who: string, componentId: string, from: string, to: string | null, recurring: boolean) {
  row[key] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,700,$3::date,$4::date,$5) RETURNING id`, [who, componentId, from, to, recurring])).rows[0]!.id);
}
const route = (who: string, method: string, aid: string, body: unknown) =>
  call(components as Route, method, `/api/payroll/employees/${who}/components?aid=${aid}`, who, { body, query: { aid } });
const assign = (componentKey: string, from: string, to: string | undefined, recurring: boolean) =>
  assignComponentToEmployee(company, hire, comp[componentKey]!, 100, from, to, recurring, actor);

beforeAll(async () => {
  for (const [id, name] of [[company, 'Recurring clash'], [other, 'Recurring clash, other company']]) await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  const salaryRow = await seedPayrollCompany(pool, company);
  row.salary = salaryRow;
  const seeded = (await pool.query('SELECT employee_id, component_id FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0]!;
  inRun = String(seeded.employee_id);
  comp.salary = String(seeded.component_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  for (const [key, name] of [['held', 'Held'], ['ended', 'Ended'], ['voided', 'Voided'], ['live', 'Live'], ['scoped', 'Scoped'], ['host', 'Host'], ['same', 'Same'], ['patch', 'Patch'], ['voidP', 'VoidP']]) await component(key, name);

  // February: the salary AND a once-off of the same component are read and paid.
  await add('salaryOnceOff', inRun, comp.salary!, '2026-02-10', '2026-02-28', false);
  const feb = await calculatedRun(call, 2);
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${feb}/journal-plan`, feb);
  await authorisePayRun(call, feb);
  const approved = await call(approve as Route, 'POST', `/api/payroll/runs/${feb}/approve`, feb, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);

  hire = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,'CL-1','Clash','Hire','2026-03-01','active',false)`, [hire, company]);
  await add('held', hire, comp.held!, '2026-03-01', null, true);
  await add('endedRow', hire, comp.ended!, '2026-03-01', '2026-03-31', true);
  await add('voidedRow', hire, comp.voided!, '2026-05-10', '2026-05-09', true);
  await add('liveRow', hire, comp.live!, '2026-04-01', '2026-04-30', true);
  await add('heldOnce', hire, comp.held!, '2026-06-05', '2026-06-20', false);
  await add('hostOnce', hire, comp.host!, '2026-04-10', '2026-04-30', false);
  await add('sameSib', hire, comp.same!, '2026-03-01', '2026-03-31', true);
  await add('patchSib', hire, comp.patch!, '2026-03-01', '2026-03-31', true);
  await add('patchRow', hire, comp.patch!, '2026-04-10', '2026-04-30', true);
  await add('voidPSib', hire, comp.voidP!, '2026-05-10', '2026-05-09', true);
  await add('voidPRow', hire, comp.voidP!, '2026-05-01', '2026-05-04', true);
  await add('scopedRow', hire, comp.scoped!, '2026-03-01', null, true);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('a once-off sits on a recurring row of the same component', () => {
  it('assigned over it: accepted', async () => {
    await expect(assign('held', '2026-04-10', '2026-04-30', false)).resolves.toBeDefined();
  });

  it('a recurring row assigned over a once-off of the same component: accepted', async () => {
    await expect(assign('host', '2026-04-01', undefined, true)).resolves.toBeDefined();
  });

  it('edited over it: accepted', async () => {
    const out = await route(hire, 'PATCH', row.heldOnce!, { effectiveFrom: '2026-06-10', effectiveTo: '2026-06-20' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  });

  it('End of a recurring row that has a paid once-off sibling: accepted', async () => {
    const out = await route(inRun, 'DELETE', row.salary!, { effectiveTo: '2026-12-31' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  });
});

describe('a recurring row clashes with a live recurring row only', () => {
  it('over a live recurring row: refused', async () => {
    await expect(assign('live', '2026-04-15', undefined, true)).rejects.toThrow(/overlap the employee's other assignment/i);
  });

  it('a recurring row edited over another: refused', async () => {
    await add('liveTwin', hire, comp.live!, '2026-07-01', '2026-07-31', true);
    const clash = await route(hire, 'PATCH', row.liveTwin!, { effectiveFrom: '2026-04-20', effectiveTo: '2026-07-31' });
    expect(clash.statusCode).toBe(400);
    expect(clash.body.error?.message).toMatch(/overlap the employee's other assignment/i);
  });

  it('a sibling that ended the day before the new start: accepted', async () => {
    await expect(assign('ended', '2026-04-01', undefined, true)).resolves.toBeDefined();
  });

  it('a sibling ending the very day the new row starts: refused', async () => {
    await expect(assign('same', '2026-03-31', undefined, true)).rejects.toThrow(/overlap the employee's other assignment/i);
  });

  it('the same through Edit dates: a row moved to start on its sibling\'s last day is refused; the day after is accepted', async () => {
    const clash = await route(hire, 'PATCH', row.patchRow!, { effectiveFrom: '2026-03-31', effectiveTo: '2026-04-30' });
    expect(clash.statusCode).toBe(400);
    expect(clash.body.error?.message).toMatch(/overlap the employee's other assignment/i);
    const ok = await route(hire, 'PATCH', row.patchRow!, { effectiveFrom: '2026-04-01', effectiveTo: '2026-04-30' });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });

  it('Edit dates over a voided sibling (ends before it starts): accepted', async () => {
    const out = await route(hire, 'PATCH', row.voidPRow!, { effectiveFrom: '2026-05-05', effectiveTo: '2026-05-31' });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  });

  it('a voided sibling (ends before it starts): accepted', async () => {
    await expect(assign('voided', '2026-05-01', undefined, true)).resolves.toBeDefined();
  });
});

describe('the sibling query is scoped to the company', () => {
  it("another company's guard does not see this company's rows for the same employee id", async () => {
    await expect(withTransaction((tx) => refuseAssignmentWrite(tx, other,
      { employeeId: hire, componentId: comp.scoped!, from: '2026-06-01', to: null, recurring: true }))).resolves.toBeUndefined();
  });
});
