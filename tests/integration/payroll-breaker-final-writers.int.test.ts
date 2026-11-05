/**
 * Final payroll breaker (2026-11-02), component writers through the real routes:
 *   7  assign, batch post and package apply refuse a once-off dated in an already-paid month, and assign/batch refuse a
 *      once-off whose explicit end runs past its month, as Edit dates does.
 *   8  a paid run calculated before migration 953 (calculated_at NULL) read components on the 27th: the paid-month
 *      check uses that rule for it.
 *   9  Edit dates keeps the row's supersede when it judges what a paid run read.
 *  10  apply-package and batch post answer the 5s company-lock timeout with 503.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { authorisePayRun, calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import applyPackage from '../../pages/api/payroll/employees/[id]/apply-package';
import postBatchRoute from '../../pages/api/payroll/batches/[id]/post';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { addBatchLines, createBatch, validateBatch } from '@/modules/accounting/services/payroll/payrollBatchService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const pkg = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let employee = '';
let bonus = '';

const url = (aid?: string) => `/api/payroll/employees/${employee}/components${aid ? `?aid=${aid}` : ''}`;
const assign = (body: Record<string, unknown>) => call(components as Route, 'POST', url(), employee, { body: { componentId: bonus, amount: 100, ...body } });
const cancel = (aid: string) => call(components as Route, 'DELETE', url(aid), employee, { body: { effectiveTo: '2026-01-01', cancel: true }, query: { aid } });
const patch = (aid: string, body: unknown) => call(components as Route, 'PATCH', url(aid), employee, { body, query: { aid } });
async function approveRun(run: string) {
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run);
  await authorisePayRun(call, run);
  const out = await call(approve as Route, 'POST', `/api/payroll/runs/${run}/approve`, run, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
}
async function rawOnceOff(from: string, to: string, supersededAt: string | null = null): Promise<string> {
  return String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred,superseded_at)
     VALUES($1,$2,100,$3::date,$4::date,false,false,$5::timestamptz) RETURNING id`, [employee, bonus, from, to, supersededAt])).rows[0]!.id);
}
async function batchPost(month: number, day: string, effectiveTo?: Date) {
  const batch = await createBatch({ companyId: company, batchType: 'component_values', componentId: bonus, description: `FB ${month}`,
    periodYear: 2026, periodMonth: month, isRecurring: false, userId: admin });
  await addBatchLines(company, batch.id, [{ employeeId: employee, value: 100, effectiveFrom: new Date(day), ...(effectiveTo ? { effectiveTo } : {}) }]);
  expect((await validateBatch(company, batch.id)).ok).toBe(true);
  return call(postBatchRoute as Route, 'POST', `/api/payroll/batches/${batch.id}/post`, batch.id);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Final breaker writers']);
  const row = await seedPayrollCompany(pool, company);
  employee = String((await pool.query('SELECT employee_id FROM payroll_employee_components WHERE id=$1', [row])).rows[0]!.employee_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [bonus, company]);
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'FB-PKG','FB package')", [pkg, company]);
  // The package's once-off is a component the employee holds nothing of, so the apply cuts nothing.
  const signOn = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Sign-on','3605','earning')", [signOn, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,500,false)', [pkg, signOn]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('8: a paid run from before 953 read on the 27th', () => {
  it('a once-off 5-14 March was not read by it (cancel allowed); one covering the 27th was (cancel refused)', async () => {
    const short = await rawOnceOff('2026-03-05', '2026-03-14');
    const covering = await rawOnceOff('2026-03-20', '2026-03-31');
    const march = await calculatedRun(call, 3);
    await approveRun(march);
    await pool.query('UPDATE payroll_run_headers SET calculated_at = NULL, calculation_version = NULL WHERE id=$1', [march]);
    expect((await cancel(short)).statusCode).toBe(200);
    const refused = await cancel(covering);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toMatch(/already paid in 2026-03/);
  });
});

describe('9: a change keeps the supersede when it judges a paid month', () => {
  it('a once-off superseded before April was calculated was not paid in April: ending it earlier is allowed; editing it is refused', async () => {
    const cut = await rawOnceOff('2026-04-05', '2026-04-14', '2026-01-01T00:00:00Z');
    const april = await calculatedRun(call, 4);
    await approveRun(april);
    const ended = await call(components as Route, 'DELETE', url(cut), employee, { body: { effectiveTo: '2026-04-10' }, query: { aid: cut } });
    expect(ended.statusCode, JSON.stringify(ended.body)).toBe(200);
    // Edit dates refuses a superseded row outright (blind review 2026-11-02, payroll-leaver-exemption.int).
    expect((await patch(cut, { effectiveFrom: '2026-04-06', effectiveTo: '2026-04-10' })).statusCode).toBe(400);
  });
});

describe('7: writers refuse a once-off in a paid month, or running past its month', () => {
  it('assign: dated in paid March, or ending in the next month', async () => {
    const paid = await assign({ effectiveFrom: '2026-03-10', isRecurring: false });
    expect(paid.statusCode).toBe(400);
    expect(paid.body.error?.message).toMatch(/2026-03 .*already paid/);
    const long = await assign({ effectiveFrom: '2026-08-10', effectiveTo: '2026-09-05', isRecurring: false });
    expect(long.statusCode).toBe(400);
    expect(long.body.error?.message).toMatch(/one month/i);
  });

  it('batch post: a line dated in paid April; a line ending in the next month', async () => {
    const paid = await batchPost(4, '2026-04-10');
    expect(paid.statusCode).toBe(400);
    expect(paid.body.error?.message).toMatch(/2026-04 .*already paid/);
    const long = await batchPost(8, '2026-08-10', new Date('2026-09-05'));
    expect(long.statusCode).toBe(400);
    expect(long.body.error?.message).toMatch(/one month/i);
  });

  it('package apply: its once-off would land in paid March', async () => {
    const out = await call(applyPackage as Route, 'POST', `/api/payroll/employees/${employee}/apply-package`, employee,
      { body: { packageId: pkg, effectiveFrom: '2026-03-25' } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/2026-03 .*already paid/);
  });
});

describe('10: the routes answer a held company lock with 503', () => {
  async function whileLocked(request: () => Promise<{ statusCode: number }>): Promise<number> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${company}`]);
      return (await request()).statusCode;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }

  it('apply-package', async () => {
    expect(await whileLocked(() => call(applyPackage as Route, 'POST', `/api/payroll/employees/${employee}/apply-package`, employee,
      { body: { packageId: pkg, effectiveFrom: '2026-10-10' } }))).toBe(503);
  }, 20000);

  it('batch post', async () => {
    const batch = await createBatch({ companyId: company, batchType: 'component_values', componentId: bonus, description: 'FB lock',
      periodYear: 2026, periodMonth: 11, isRecurring: false, userId: admin });
    await addBatchLines(company, batch.id, [{ employeeId: employee, value: 100, effectiveFrom: new Date('2026-11-10') }]);
    expect((await validateBatch(company, batch.id)).ok).toBe(true);
    expect(await whileLocked(() => call(postBatchRoute as Route, 'POST', `/api/payroll/batches/${batch.id}/post`, batch.id))).toBe(503);
  }, 20000);
});
