/**
 * A row dated into a month an approved run read is never paid for it by that run, whoever the run paid. So every writer
 * judges paid months company-wide, not on the employee's own lines (security finding, 2026-11-03):
 *   - assign, batch post and package apply refuse a RECURRING row whose window touches a paid calendar month, as they
 *     already refuse a once-off dated in one;
 *   - Edit dates refuses a once-off moved into, or a recurring row stretched into, a paid month the row did not already
 *     touch, by calendar overlap (not by what a run read: a pre-953 run read the 27th, a post-953 one the last day);
 *   - an edit that adds no paid month is left to the employee's own paid runs (paidPeriodChanged);
 *   - another company's paid months never refuse this company.
 * The outsider is hired after February is approved, so he has no line on it. January is a pre-953 paid month.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { addBatchLines, createBatch, postBatch, validateBatch } from '@/modules/accounting/services/payroll/payrollBatchService';
import { updateEmployeeComponentDates } from '@/modules/accounting/services/payroll/payrollComponentDateEdit';
import { assignEmployeeComponentTool } from '@/lib/mcp/tools/writeEmployees';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const admin = crypto.randomUUID();
const pkg = crypto.randomUUID();
const actor = { userId: admin, channel: 'rest' as const };
let call: ReturnType<typeof routeCaller>;
let inRun = '';
let outsider = '';
let bonus = '';
const comp: Record<string, string> = {};
const row: Record<string, string> = {};

const patch = (who: string, aid: string, body: unknown) =>
  call(components as Route, 'PATCH', `/api/payroll/employees/${who}/components?aid=${aid}`, who, { body, query: { aid } });
const datesOf = async (id: string) => (await pool.query(
  "SELECT to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [id])).rows[0];
async function add(key: string, who: string, component: string, from: string, to: string | null, recurring: boolean) {
  row[key] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,700,$3::date,$4::date,$5) RETURNING id`, [who, component, from, to, recurring])).rows[0]!.id);
}
async function refused(key: string, body: unknown, message: RegExp, who = outsider) {
  const before = await datesOf(row[key]!);
  const out = await patch(who, row[key]!, body);
  expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
  expect(out.body.error?.message).toMatch(message);
  expect(await datesOf(row[key]!)).toEqual(before);
}
async function batch(from: string, component = comp.batchable!) {
  const b = await createBatch({ companyId: company, batchType: 'component_values', componentId: component, description: `CW ${from}`,
    periodYear: 2026, periodMonth: Number(from.slice(5, 7)), isRecurring: true, userId: admin });
  await addBatchLines(company, b.id, [{ employeeId: outsider, value: 100, effectiveFrom: new Date(from) }]);
  expect((await validateBatch(company, b.id)).ok).toBe(true);
  return postBatch(company, b.id, admin);
}
async function approvedHeader(co: string, month: number, preAfter953: boolean) {
  const id = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'approved')", [id, co, month]);
  if (preAfter953) await pool.query('UPDATE payroll_run_headers SET calculated_at = NULL, calculation_version = NULL WHERE id=$1', [id]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Company-wide paid months']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'Other company, paid Mar and Apr']);
  const salaryRow = await seedPayrollCompany(pool, company);
  row.salary = salaryRow;
  inRun = String((await pool.query('SELECT employee_id FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0]!.employee_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  bonus = crypto.randomUUID();
  const salaryComponent = String((await pool.query('SELECT component_id FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0]!.component_id);
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [bonus, company]);
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'CW-PKG','Company-wide package')", [pkg, company]);

  await add('inRunOnceOff', inRun, bonus, '2026-02-10', '2026-02-28', false);
  // February is approved through the real routes; January is a paid month from before migration 953.
  const feb = await calculatedRun(call, 2);
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${feb}/journal-plan`, feb);
  const approved = await call(approve as Route, 'POST', `/api/payroll/runs/${feb}/approve`, feb, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
  await approvedHeader(company, 1, true);
  await approvedHeader(other, 3, false);
  await approvedHeader(other, 4, false);

  outsider = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,'OUT-1','Out','Sider','2026-03-01','active',false)`, [outsider, company]);
  await add('onceOff', outsider, bonus, '2026-04-10', '2026-04-30', false);
  await add('recurring', outsider, salaryComponent, '2026-03-01', null, true);
  // Each in its own component, so no move overlaps another row of the same component.
  const rows = [
    ['onceOffMay', 'Perk', false, '2026-05-10', '2026-05-31'], ['recurringMay', 'Stipend', true, '2026-05-01', '2026-05-31'],
    ['bandEnd', 'Band', true, '2026-04-01', '2026-04-30'], ['preJan', 'Pre', true, '2026-04-01', '2026-04-30'],
    ['onceOffJan', 'Late', false, '2026-04-10', '2026-04-30'], ['ended', 'Ended', true, '2025-10-01', '2025-12-31'],
    ['held', 'Held', true, '2026-03-01', null],
  ] as const;
  for (const [key, name, recurring, from, to] of rows) {
    comp[key] = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3605','earning')", [comp[key], company, name]);
    await add(key, outsider, comp[key], from, to, recurring);
  }
  for (const name of ['assignable', 'batchable', 'packaged']) {
    comp[name] = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3605','earning')", [comp[name], company, name]);
  }
  // The package's component is one the hire holds nothing hand-entered of (a hand-entered once-off is not the apply's to cancel).
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,900,true)', [pkg, comp.packaged]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await cleanPayrollCompanies(pool, [company, other]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('Edit dates, an employee who is not on the approved run', () => {
  it('a once-off moved into the paid month', () => refused('onceOff', { effectiveFrom: '2026-02-10', effectiveTo: '2026-02-20' }, /2026-02 .*already paid/i));
  it('a recurring row stretched back into the paid month', () => refused('recurring', { effectiveFrom: '2026-01-01', effectiveTo: null }, /2026-0[12] .*already paid/i));
  it('a recurring row moved to the paid month before the 28th (a post-953 run reads the last day, the row is still dated in it)',
    () => refused('bandEnd', { effectiveFrom: '2026-02-01', effectiveTo: '2026-02-27' }, /2026-02 .*already paid/i));
  it('a paid month from before 953, which read the 27th: a row from the 28th is still dated in it',
    () => refused('preJan', { effectiveFrom: '2026-01-28', effectiveTo: '2026-01-31' }, /2026-01 .*already paid/i));
});

describe('Edit dates, more paid-month cases', () => {
  it('a once-off moved into the pre-953 January, 28th to 31st', () =>
    refused('onceOffJan', { effectiveFrom: '2026-01-28', effectiveTo: '2026-01-31' }, /2026-01 .*already paid/i));
  it("an ended row's end extended into the paid months", () =>
    refused('ended', { effectiveFrom: '2025-10-01', effectiveTo: '2026-02-15' }, /2026-0[12] .*already paid/i));
});

describe('Edit dates, what is left to the employee\'s own paid runs', () => {
  it('a once-off staying inside its own paid month, and a no-op re-save, are accepted', async () => {
    expect((await patch(inRun, row.inRunOnceOff!, { effectiveFrom: '2026-02-15', effectiveTo: '2026-02-28' })).statusCode).toBe(200);
    expect((await patch(inRun, row.inRunOnceOff!, { effectiveFrom: '2026-02-15', effectiveTo: '2026-02-28' })).statusCode).toBe(200);
    expect(await datesOf(row.inRunOnceOff!)).toEqual({ f: '2026-02-15', t: '2026-02-28' });
  });

  it('shrinking a paid recurring row out of its paid month is refused by the employee\'s own run', () =>
    refused('salary', { effectiveFrom: '2020-01-01', effectiveTo: '2026-01-31' }, /2026-02 .*already paid/i, inRun));

  it('edits that add no paid month are accepted', async () => {
    expect((await patch(outsider, row.onceOff!, { effectiveFrom: '2026-04-15', effectiveTo: '2026-04-30' })).statusCode).toBe(200);
    expect((await patch(outsider, row.recurring!, { effectiveFrom: '2026-03-15', effectiveTo: null })).statusCode).toBe(200);
  });
});

describe("another company's paid months", () => {
  // Through the service, which opens no request transaction: the company filter in the query is all that keeps the
  // other company's rows out (through a route, row-level security would hide them anyway).
  it('do not refuse this company: a once-off and a recurring row moved into April, which only the other company paid', async () => {
    await expect(updateEmployeeComponentDates(company, row.onceOffMay!, '2026-04-10', '2026-04-30', actor)).resolves.toBe(true);
    await expect(updateEmployeeComponentDates(company, row.recurringMay!, '2026-04-20', '2026-05-31', actor)).resolves.toBe(true);
  });
});

describe('the writers refuse a recurring row dated in a paid month, for an employee not on that run', () => {
  const paidMonth = /2026-02 .*already paid/i;
  it('assign', async () => {
    const a = comp.assignable!;
    await expect(assignComponentToEmployee(company, outsider, a, 100, '2026-02-01', undefined, true, actor)).rejects.toThrow(paidMonth);
    await expect(assignComponentToEmployee(company, outsider, a, 100, '2026-03-01', undefined, true, actor)).resolves.toBeDefined();
  });

  it('assign, a second live recurring row of the same component overlapping the first: refused as Edit dates refuses it', async () => {
    await expect(assignComponentToEmployee(company, outsider, comp.held!, 100, '2026-04-01', undefined, true, actor))
      .rejects.toThrow(/overlap the employee's other assignment/i);
  });

  it('batch post, the same overlap, and the refusal names the employee', async () => {
    await expect(batch('2026-04-01', comp.held)).rejects.toThrow(/OUT-1.*overlap the employee's other assignment/i);
  });

  it('MCP assign_employee_component answers the refusal as a tool error', async () => {
    const out = await assignEmployeeComponentTool.handler({ employee_id: outsider, component_id: comp.assignable, amount: 100,
      effective_from: '2026-02-01', idempotency_key: crypto.randomUUID() },
    { companyId: company, userId: admin, scopes: ['write:payroll'], companyRole: 'owner', tokenJti: null, oauthAppId: null } as never);
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/2026-02 .*already paid/i);
  });

  it('batch post', async () => {
    await expect(batch('2026-02-01')).rejects.toThrow(paidMonth);
    await expect(batch('2026-03-01')).resolves.toEqual({ inserted: 1 });
  });

  it('package apply', async () => {
    await expect(applyPackageToEmployee(company, pkg, outsider, '2026-02-01', admin)).rejects.toThrow(paidMonth);
    await expect(applyPackageToEmployee(company, pkg, outsider, '2026-03-01', admin)).resolves.toMatchObject({ inserted: 1 });
  });
});
