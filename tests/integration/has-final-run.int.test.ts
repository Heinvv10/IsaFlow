/**
 * Wave 5 UXP: GET /api/payroll/employees/[id]/has-final-run through the real route (withAuth, app_user, RLS)
 * against the disposable fixture. "Final" is the R-035 guard's verdict, never the status column: a draft-only
 * employee is false, an approved-and-cleared run is true, a run approved under the grandfather rule is true, and
 * an approved row the guard never cleared is false. Another company's employee is 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import hasFinalRun from '../../pages/api/payroll/employees/[id]/has-final-run';
import createRun from '../../pages/api/payroll/runs';
import { rig, type Route } from './brkr.helpers';
import { callRoute } from './r035-approval.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
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
async function runFor(company: string, employee: string, month: number, status: string, extra = ''): Promise<void> {
  const run = (await r.pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1, $2, 2026, 'calculated') RETURNING id::text AS id`,
    [company, month])).rows[0]!.id;
  await r.pool.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 10000, 9000)`, [run, employee]);
  await r.pool.query(`UPDATE payroll_run_headers SET status = $2 ${extra} WHERE id = $1`, [run, status]);
}

const ask = (employee: string, company = r.company) =>
  callRoute(hasFinalRun as never, r.tokens[r.admin]!, company, 'GET', undefined, `/api/payroll/employees/${employee}/has-final-run`, { id: employee });
const answer = async (employee: string) => {
  const res = await ask(employee);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as { data: { hasFinalRun: boolean } }).data.hasFinalRun;
};

beforeAll(async () => {
  r = await rig('hasfinalrun');
  await r.setup();
  cleared = (await r.employee(30000)).employee;
  const made = await r.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 1, year: 2026 } });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const runId = String(made.body.data!.id);
  expect((await r.api.calculate(runId)).statusCode).toBe(200);
  expect((await r.api.approve(runId)).statusCode).toBe(200);
  ids.draft = await plainEmployee(r.company, 'HFR-DRAFT');
  await runFor(r.company, ids.draft, 2, 'calculated');
  ids.unreviewed = await plainEmployee(r.company, 'HFR-UNREV');
  await runFor(r.company, ids.unreviewed, 3, 'approved', `, approved_plan_hash = 'never-reviewed'`);
  ids.grandfathered = await plainEmployee(r.company, 'HFR-GF');
  await runFor(r.company, ids.grandfathered, 4, 'approved', ', approval_grandfathered_at = clock_timestamp()');
  ids.none = await plainEmployee(r.company, 'HFR-NONE');
  otherCompany = crypto.randomUUID();
  await r.pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [otherCompany, 'HFR other company']);
  otherEmp = await plainEmployee(otherCompany, 'HFR-OTHER');
  await runFor(otherCompany, otherEmp, 2, 'approved', ', approval_grandfathered_at = clock_timestamp()');
}, 240000);

afterAll(async () => { await r.teardown([otherCompany]); });

describe('GET has-final-run', () => {
  it('an employee on no run is false', async () => { expect(await answer(ids.none!)).toBe(false); });
  it('a draft-only employee (a calculated run) is false', async () => { expect(await answer(ids.draft!)).toBe(false); });
  it('an approved row the R-035 guard never cleared, not grandfathered, is false', async () => { expect(await answer(ids.unreviewed!)).toBe(false); });
  it('an employee on an approved and cleared run is true', async () => { expect(await answer(cleared)).toBe(true); });
  it('an employee on a run approved under the grandfather rule is true', async () => { expect(await answer(ids.grandfathered!)).toBe(true); });

  it('another company\'s employee is 404 through the route', async () => {
    expect((await ask(otherEmp)).state.statusCode).toBe(404);
  });

  it('the service\'s own company predicate: with no RLS behind it, another company\'s employee is null', async () => {
    expect(await outsideRls(r.pool, r.company, () => employeeHasFinalRun(r.company, otherEmp))).toBeNull();
  });

  it('every answer is no-store', async () => {
    for (const res of [await ask(cleared), await ask(otherEmp)]) expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
