/**
 * A once-off is paid in the run of the month it falls in (breaker round, Hein 2026-11-02), not only when its window
 * reaches the period's last day: a once-off from 10 to 27 November, or one dated the 28th alone, is paid in November.
 *
 * Rule for non-recurring rows (payrollComponentService.getEmployeeComponents): paid when the window covers the
 * read date (the period's last day, as before) OR starts inside the period, unless a supersede ended it (another row
 * of the same component starts the day after it ends: payPackageService re-apply, or a once-off replaced). A window
 * that started in an earlier month and ends before this month's last day is not paid again in this month: it was
 * paid in the month whose last day it covered. Voided rows (ending before they start) are never paid.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';
import { endEmployeeComponent } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const runs = { oct: crypto.randomUUID(), nov: crypto.randomUUID(), dec: crypto.randomUUID() } as const;
const comp = { salary: crypto.randomUUID(), bonus: crypto.randomUUID(), allowance: crypto.randomUUID(), pkgBasic: crypto.randomUUID() };
const pkg = crypto.randomUUID();
const emp: Record<string, string> = {};
const SALARY = 20000;

async function employee(key: string, rows: Array<[string, number, string, string | null, boolean]>) {
  const id = crypto.randomUUID();
  emp[key] = id;
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Once','Off','2020-01-01','active',false)`, [id, company, `OW-${key}`]);
  for (const [component, amount, from, to, recurring] of [['salary', SALARY, '2020-01-01', null, true] as const, ...rows]) {
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
       VALUES($1,$2,$3,$4::date,$5::date,$6)`, [id, comp[component as keyof typeof comp], amount, from, to, recurring]);
  }
}

async function paid(run: string, key: string): Promise<Array<[string, number]>> {
  const { rows } = await pool.query('SELECT component_breakdown FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, emp[key]]);
  return (rows[0].component_breakdown as Array<{ componentName: string; amount: number }>)
    .map((c): [string, number] => [c.componentName, Number(c.amount)])
    .sort(([a, x], [b, y]) => a.localeCompare(b) || x - y);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-31T12:00:00+02:00'));
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Once-off window fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name, code] of [[comp.salary, 'Basic salary', '3601'], [comp.bonus, 'Bonus', '3605'],
    [comp.allowance, 'Allowance', '3713'], [comp.pkgBasic, 'Package basic', '3601']]) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,$3,$4,'earning',true,true,true)`, [id, company, name, code]);
  }
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'OW-PKG','Once-off window package')", [pkg, company]);
  await pool.query(
    `INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false),($1,$3,3000,true)`,
    [pkg, comp.bonus, comp.pkgBasic]);

  await employee('mid', [['bonus', 1500, '2026-11-10', '2026-11-27', false]]);
  await employee('day28', [['bonus', 700, '2026-11-28', '2026-11-28', false]]);
  await employee('reapply', []);
  await applyPackageToEmployee(company, pkg, emp.reapply!, '2026-11-01', user);
  await applyPackageToEmployee(company, pkg, emp.reapply!, '2026-11-15', user);
  // A once-off replaced by a standing allowance of the same component from the 20th.
  await employee('replaced', [['allowance', 400, '2026-11-05', '2026-11-19', false], ['allowance', 650, '2026-11-20', null, true]]);
  await employee('tail', [['bonus', 900, '2026-10-15', '2026-11-10', false]]);
  await employee('voided', [['bonus', 999, '2026-11-20', '2026-11-19', false]]);
  // Voided by a package applied on the 15th to a row starting on the 25th: the end is days before the start.
  await employee('voidedFar', [['bonus', 888, '2026-11-25', '2026-11-14', false]]);
  await employee('legacyOpen', [['bonus', 300, '2026-09-01', null, false]]);
  // Ended (End on the profile, the DELETE route, the MCP tool) before November is paid: cancelled, not shortened.
  await employee('ended', [['bonus', 450, '2026-11-05', '2026-11-30', false]]);
  const endedRow = String((await pool.query('SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND NOT is_recurring', [emp.ended])).rows[0]!.id);
  expect(await endEmployeeComponent(company, endedRow, new Date('2026-11-20'))).toBe(true);
  // A voided row of the same component starting the day after a short once-off does not supersede it.
  await employee('voidedNext', [['bonus', 1500, '2026-11-10', '2026-11-27', false], ['bonus', 610, '2026-11-28', '2026-11-27', false]]);

  for (const [id, month] of [[runs.oct, 10], [runs.nov, 11], [runs.dec, 12]] as const) {
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'draft')", [id, company, month]);
    await calculatePayrollRun(id, company);
  }
});

afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [Object.values(runs)]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=ANY($1::uuid[])', [Object.values(emp)]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe(`once-offs inside the month (TZ=${process.env.TZ ?? 'unset'})`, () => {
  it('R1 500 from 10 to 27 November is paid in November, not October or December', async () => {
    expect(await paid(runs.nov, 'mid')).toEqual([['Basic salary', SALARY], ['Bonus', 1500]]);
    expect(await paid(runs.oct, 'mid')).toEqual([['Basic salary', SALARY]]);
    expect(await paid(runs.dec, 'mid')).toEqual([['Basic salary', SALARY]]);
  });

  it('a once-off for 28 November alone is paid in November, once', async () => {
    expect(await paid(runs.nov, 'day28')).toEqual([['Basic salary', SALARY], ['Bonus', 700]]);
    expect(await paid(runs.dec, 'day28')).toEqual([['Basic salary', SALARY]]);
  });
});

describe('no double pay', () => {
  it('a package re-applied in the same month pays its once-off once (K-025)', async () => {
    expect(await paid(runs.nov, 'reapply')).toEqual([['Basic salary', SALARY], ['Bonus', 1200], ['Package basic', 3000]]);
    expect(await paid(runs.dec, 'reapply')).toEqual([['Basic salary', SALARY], ['Package basic', 3000]]);
  });

  it('a once-off ended by a same-component row starting the next day is not paid beside it', async () => {
    expect(await paid(runs.nov, 'replaced')).toEqual([['Allowance', 650], ['Basic salary', SALARY]]);
  });

  it('a window from 15 October to 10 November is paid in October only', async () => {
    expect(await paid(runs.oct, 'tail')).toEqual([['Basic salary', SALARY], ['Bonus', 900]]);
    expect(await paid(runs.nov, 'tail')).toEqual([['Basic salary', SALARY]]);
  });

  it('a voided once-off is never paid', async () => {
    for (const run of Object.values(runs)) {
      expect(await paid(run, 'voided')).toEqual([['Basic salary', SALARY]]);
      expect(await paid(run, 'voidedFar')).toEqual([['Basic salary', SALARY]]);
    }
  });

  it('a once-off ended before its month is paid is cancelled: voided, never paid', async () => {
    const { rows } = await pool.query(
      "SELECT effective_to < effective_from AS voided FROM payroll_employee_components WHERE employee_id=$1 AND NOT is_recurring", [emp.ended]);
    expect(rows).toEqual([{ voided: true }]);
    for (const run of Object.values(runs)) expect(await paid(run, 'ended')).toEqual([['Basic salary', SALARY]]);
  });

  it('a voided same-component row starting the next day does not cancel the R1 500 once-off', async () => {
    expect(await paid(runs.nov, 'voidedNext')).toEqual([['Basic salary', SALARY], ['Bonus', 1500]]);
  });

  it('a legacy open-ended once-off keeps paying every month, as before', async () => {
    for (const run of Object.values(runs)) expect(await paid(run, 'legacyOpen')).toEqual([['Basic salary', SALARY], ['Bonus', 300]]);
  });
});
