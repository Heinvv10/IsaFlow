/**
 * Wave 6 UXR: GET /api/payroll/employees/[id]/readiness through the real route (withAuth, app_user, RLS) against the
 * disposable fixture. One read answers bank on file (active row only), the latest worked-out run (calculated,
 * approved or paid; never a later-dated run of another company) and the final-run verdict, which must equal
 * `employeeHasFinalRun` for every employee. Another company's employee is 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import readiness from '../../pages/api/payroll/employees/[id]/readiness';
import createRun from '../../pages/api/payroll/runs';
import { rig, type Route } from './brkr.helpers';
import { callRoute } from './r035-approval.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
import { readEmployeeReadiness, type EmployeeReadinessRead } from '../../src/modules/accounting/services/payroll/employeeReadinessRead';
import { employeeHasFinalRun } from '../../src/modules/accounting/services/payroll/employeeFinalRun';

let r: Awaited<ReturnType<typeof rig>>;
let cleared = '', otherCompany = '', otherEmp = '';
const ids: Record<string, string> = {};

async function plainEmployee(company: string, number: string): Promise<string> {
  return (await r.pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, $2, 'Final', 'Run', '2020-01-01') RETURNING id::text AS id`, [company, number])).rows[0]!.id;
}

/** A run header with one line for the employee, set to `status` (and grandfathered or planned as asked). */
async function runFor(company: string, employee: string, month: number, status: string, extra = '', year = 2026): Promise<void> {
  const run = (await r.pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1, $2, $3, 'calculated') RETURNING id::text AS id`,
    [company, month, year])).rows[0]!.id;
  await r.pool.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 10000, 9000)`, [run, employee]);
  await r.pool.query(`UPDATE payroll_run_headers SET status = $2 ${extra} WHERE id = $1`, [run, status]);
}

const ask = (employee: string, company = r.company) =>
  callRoute(readiness as never, r.tokens[r.admin]!, company, 'GET', undefined, `/api/payroll/employees/${employee}/readiness`, { id: employee });
const answer = async (employee: string): Promise<EmployeeReadinessRead> => {
  const res = await ask(employee);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as { data: EmployeeReadinessRead }).data;
};
const bankRow = (company: string, employee: string, active: boolean) => r.pool.query(
  `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code, is_active)
   VALUES ($1, $2, 'FNB', '62000000001', '250655', $3)`, [company, employee, active]);

beforeAll(async () => {
  r = await rig('readiness');
  await r.setup();
  cleared = (await r.employee(30000)).employee;
  const made = await r.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 1, year: 2026 } });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const runId = String(made.body.data!.id);
  expect((await r.api.calculate(runId)).statusCode).toBe(200);
  expect((await r.api.approve(runId)).statusCode).toBe(200);
  ids.draft = await plainEmployee(r.company, 'UXR-DRAFT');
  await runFor(r.company, ids.draft, 2, 'calculated');
  ids.unreviewed = await plainEmployee(r.company, 'UXR-UNREV');
  await runFor(r.company, ids.unreviewed, 3, 'approved', `, approved_plan_hash = 'never-reviewed'`);
  ids.grandfathered = await plainEmployee(r.company, 'UXR-GF');
  await runFor(r.company, ids.grandfathered, 4, 'approved', ', approval_grandfathered_at = clock_timestamp()');
  // 25 newer drafts and one older final run: a capped history would miss the final one.
  ids.many = await plainEmployee(r.company, 'UXR-MANY');
  await runFor(r.company, ids.many, 1, 'approved', ', approved_at = clock_timestamp()', 2020);
  for (let i = 0; i < 25; i++) await runFor(r.company, ids.many, (i % 12) + 1, 'calculated', '', i < 12 ? 2027 : i < 24 ? 2028 : 2029);
  ids.none = await plainEmployee(r.company, 'UXR-NONE');
  ids.banked = await plainEmployee(r.company, 'UXR-BANK');
  await bankRow(r.company, ids.banked, true);
  ids.oldBank = await plainEmployee(r.company, 'UXR-OLDBANK');
  await bankRow(r.company, ids.oldBank, false);
  otherCompany = crypto.randomUUID();
  await r.pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [otherCompany, 'UXR other company']);
  otherEmp = await plainEmployee(otherCompany, 'UXR-OTHER');
  await runFor(otherCompany, otherEmp, 2, 'approved', ', approval_grandfathered_at = clock_timestamp()');
  // Ten years later than anything of ours: it must never be our latest run.
  await runFor(otherCompany, otherEmp, 6, 'approved', ', approval_grandfathered_at = clock_timestamp()', 2036);
  await bankRow(otherCompany, otherEmp, true);
}, 240000);

afterAll(async () => { await r.teardown([otherCompany]); });

describe('GET readiness', () => {
  it('bank is on-file only for an active row: none for no row and for an inactive-only row', async () => {
    expect((await answer(ids.banked!)).bank).toBe('on-file');
    expect((await answer(ids.none!)).bank).toBe('none');
    expect((await answer(ids.oldBank!)).bank).toBe('none');
  });

  it('runs is the latest worked-out run of THIS company: the January 2029 calculated run beats every earlier month, and the 2036 run of another company never shows', async () => {
    const read = await answer(ids.none!);
    expect(read.runs).toEqual([{ periodYear: 2029, periodMonth: 1, status: 'calculated' }]);
  });

  it('hasFinalRun equals the has-final-run service for every employee', async () => {
    for (const e of [cleared, ids.draft!, ids.unreviewed!, ids.grandfathered!, ids.many!, ids.none!]) {
      expect((await answer(e)).hasFinalRun, e).toBe(await employeeHasFinalRun(r.company, e));
    }
    expect((await answer(cleared)).hasFinalRun).toBe(true);
    expect((await answer(ids.draft!)).hasFinalRun).toBe(false);
  });

  it("another company's employee is 404 through the route", async () => {
    expect((await ask(otherEmp)).state.statusCode).toBe(404);
  });

  it("the service's own company predicate: with no RLS behind it, another company's employee is null", async () => {
    expect(await outsideRls(r.pool, r.company, () => readEmployeeReadiness(r.company, otherEmp))).toBeNull();
  });

  it('with no RLS behind it, our company never reads another company\'s runs or bank rows', async () => {
    const read = await outsideRls(r.pool, r.company, () => readEmployeeReadiness(r.company, ids.none!));
    expect(read?.runs).toEqual([{ periodYear: 2029, periodMonth: 1, status: 'calculated' }]);
    expect(read?.bank).toBe('none');
  });

  it('every answer is no-store', async () => {
    for (const res of [await ask(cleared), await ask(otherEmp)]) expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
