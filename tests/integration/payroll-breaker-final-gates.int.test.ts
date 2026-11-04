/**
 * Final payroll breaker (2026-11-02), approval gates through the real routes:
 *   1 (HIGH) a hire with pay added after the run was calculated (no line yet) refuses approval: recalculate.
 *   3 (Hein) a leaver's recurring row ending on their end date (28 March) is not flagged for a pro-rata; March pays
 *     the full salary, as before this branch, and the termination base reads that row.
 *   6 a reopened run re-approved onto its journal still in force runs the "changed after calculation" gate.
 *  11 TERMINATION_BASE_MISSING blocks only when a pay-out needs the base (leave pay-out, unserved notice, retrenchment
 *     severance); otherwise it is a warning and the run is approvable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import employees from '../../pages/api/payroll/employees';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { setTerminationDetails } from '@/modules/accounting/services/payroll/payrollTerminationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let salary = '';
let bonus = '';
let w301 = '';

const preview = async (run: string) =>
  ((await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run)).body.data as { blocker: { code: string; detail: string } | null }).blocker;
async function approveRun(run: string) {
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run);
  return call(approve as Route, 'POST', `/api/payroll/runs/${run}/approve`, run, { body: { expectedPlanHash: plan.body.data?.planHash } });
}
async function line(run: string, employee: string) {
  const { rows } = await pool.query('SELECT gross_pay::float8 AS gross, component_breakdown, validation_results FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, employee]);
  return rows[0] as { gross: number; component_breakdown: Array<{ componentName: string; amount: number }>; validation_results: Array<{ code: string; severity: string }> };
}
async function leaver(num: string, end: string, rowEnd: string | null) {
  const id = String((await pool.query(
    `INSERT INTO payroll_employees(company_id,employee_number,first_name,last_name,start_date,date_of_birth,tax_number,status,end_date,medical_aid_main_member)
     VALUES($1,$2,'Lea','Ver','2020-01-01','1980-01-01','0123456789','active',$3::date,false) RETURNING id`, [company, num, end])).rows[0]!.id);
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,supersede_inferred)
     VALUES($1,$2,21670,'2020-01-01',$3::date,FALSE)`, [id, salary, rowEnd]);
  return id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Final breaker gates']);
  const row = await seedPayrollCompany(pool, company);
  ({ employee_id: w301, component_id: salary } = (await pool.query('SELECT employee_id, component_id FROM payroll_employee_components WHERE id=$1', [row])).rows[0]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [bonus, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_termination_details WHERE company_id=$1', [company]).catch(() => undefined);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('1: a hire with pay added after calculation', () => {
  it('refuses approval until the run is recalculated', async () => {
    const run = await calculatedRun(call, 5);
    expect(await preview(run)).toBeNull();
    const hired = await call(employees as Route, 'POST', '/api/payroll/employees', undefined, { body: {
      firstName: 'New', lastName: 'Hire', employeeNumber: 'FB-HIRE', employmentType: 'permanent', startDate: '2026-05-04',
      salary: { componentId: salary, amountCents: 1_500_000 },
    } });
    expect(hired.statusCode, JSON.stringify(hired.body)).toBe(201);
    const refused = await preview(run);
    expect(refused?.code).toBe('components_changed_after_calculation');
    expect(refused?.detail).toContain('FB-HIRE');
  });
});

describe('3: a leaver whose salary row ends on their end date (Hein)', () => {
  it('28 March: not flagged, the full salary is paid in March, and the termination base reads it', async () => {
    const id = await leaver('FB-LEAVER', '2026-03-28', '2026-03-28');
    await setTerminationDetails(company, id, { reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 10, severanceWeeksPerYear: null, includeLeavePayout: false });
    const run = await calculatedRun(call, 3);
    const l = await line(run, id);
    expect(l.validation_results.map(v => v.code)).not.toContain('RECURRING_NEEDS_PRO_RATA');
    expect(l.validation_results.map(v => v.code)).not.toContain('TERMINATION_BASE_MISSING');
    expect(l.component_breakdown.find(c => c.componentName === 'Basic Salary')?.amount).toBe(21670);
    expect(l.component_breakdown.find(c => c.componentName === 'Notice Pay (Termination)')?.amount).toBe(20000);
    expect((await preview(run))?.code ?? null).not.toBe('recurring_needs_pro_rata');
  });
});

describe('11: a nil termination base blocks only when a pay-out needs it', () => {
  it('notice fully served, no leave pay-out, not a retrenchment: a warning, and the run is not refused for it', async () => {
    const id = await leaver('FB-NOPAYOUT', '2026-06-15', '2026-06-10');
    await setTerminationDetails(company, id, { reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 30, severanceWeeksPerYear: null, includeLeavePayout: false });
    const run = await calculatedRun(call, 6);
    const flag = (await line(run, id)).validation_results.find(v => v.code === 'TERMINATION_BASE_MISSING');
    expect(flag?.severity).toBe('warning');
    expect((await preview(run))?.code ?? null).not.toBe('termination_base_missing');
  });

  it('unserved notice: an error, and approval is refused', async () => {
    const id = await leaver('FB-NOTICE', '2026-07-15', '2026-07-10');
    await setTerminationDetails(company, id, { reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 10, severanceWeeksPerYear: null, includeLeavePayout: false });
    const run = await calculatedRun(call, 7);
    expect((await line(run, id)).validation_results.find(v => v.code === 'TERMINATION_BASE_MISSING')?.severity).toBe('error');
    expect((await preview(run))?.code).toBe('termination_base_missing');
  });
});

describe('6: re-approval onto a journal still in force', () => {
  it('runs the changed-after-calculation gate', async () => {
    const run = await calculatedRun(call, 9);
    const approved = await approveRun(run);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
    expect((await call(reopen as Route, 'POST', `/api/payroll/runs/${run}/reopen`, run, { body: { reason: 'L1 re-approval onto the posted journal' } })).statusCode).toBe(200);
    const once = await call(components as Route, 'POST', `/api/payroll/employees/${w301}/components`, w301,
      { body: { componentId: bonus, amount: 100, effectiveFrom: '2026-12-05', isRecurring: false } });
    expect(once.statusCode, JSON.stringify(once.body)).toBe(201);
    expect((await preview(run))?.code).toBe('components_changed_after_calculation');
  });
});
