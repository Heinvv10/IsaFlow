/**
 * Audit 2026-10-18 P3: the run taxes an annual payment (code 3605) by the SARS
 * annual-payment method, not as twelve months of it.
 *
 * Method: SARS PAYE-GEN-01-G21 (2027) Revision 1, "Annual payments/bonus".
 * Every figure is worked by hand from the 2027 rate table in
 * tests/unit/services/payroll/payrollCalculatorAnnualPayment.test.ts, where the
 * difference from the guide's banded-table figures is explained.
 *
 * October 2026 (tax year 2027), employees born 1990 (primary rebate only), no
 * medical aid. Real calculatePayrollRun on a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { setTerminationDetails } from '@/modules/accounting/services/payroll/payrollTerminationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const salary = crypto.randomUUID();
const bonus = crypto.randomUUID();
const annualLeave = crypto.randomUUID();
const run = crypto.randomUUID();
const bonusMonth = crypto.randomUUID();
const bonusOnly = crypto.randomUUID();
const underThreshold = crypto.randomUUID();
const leaver = crypto.randomUUID();

async function addEmployee(id: string, num: string, endDate: string | null, pay: Array<[string, number]>) {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,date_of_birth,status)
     VALUES($1,$2,$3,'P3',$3,DATE '2020-01-01',$4::date,DATE '1990-01-01','active')`,
    [id, company, num, endDate],
  );
  for (const [componentId, amount] of pay) {
    await pool.query(
      `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
       VALUES($1,$2,$3,DATE '2020-01-01')`, [id, componentId, amount]);
  }
}

async function line(employeeId: string) {
  const { rows } = await pool.query(
    'SELECT gross_pay, taxable_income, paye, component_breakdown FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2',
    [run, employeeId]);
  return rows[0];
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'P3 annual payment fixture']);
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
     VALUES($1,$3,'Basic salary','3601','earning',true,true,true), ($2,$3,'Annual bonus','3605','earning',true,true,true)`,
    [salary, bonus, company]);
  await pool.query(
    `INSERT INTO payroll_leave_types(id,company_id,name,bcea_type) VALUES($1,$2,'Annual leave','annual')`, [annualLeave, company]);

  await addEmployee(bonusMonth, 'P3-BONUS', null, [[salary, 28_000], [bonus, 14_800]]);
  await addEmployee(bonusOnly, 'P3-BONUS-ONLY', null, [[bonus, 120_000]]);
  await addEmployee(underThreshold, 'P3-UNDER', null, [[salary, 7_000], [bonus, 30_000]]);
  // R21 670 / 21.67 days = R1 000 a day: 10 days' leave, 20 days' unserved notice.
  await addEmployee(leaver, 'P3-LEAVER', '2026-10-31', [[salary, 21_670]]);
  await pool.query(
    `INSERT INTO payroll_leave_balances(company_id,employee_id,leave_type_id,balance_year,accrued) VALUES($1,$2,$3,2026,10)`,
    [company, leaver, annualLeave]);
  await setTerminationDetails(company, leaver, {
    reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 10, severanceWeeksPerYear: null, includeLeavePayout: true,
  });
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,10,2026,'draft')`, [run, company]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_leave_balances WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_leave_types WHERE company_id=$1', [company]);
    await pool.query(
      'DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally {
    await pool.end();
  }
});

describe('P3: the October run taxes annual payments by the SARS method', () => {
  it('salary R28 000 + bonus R14 800: PAYE 4 161.00 + 3 848.00, and the header total agrees', async () => {
    const summary = await calculatePayrollRun(run, company);
    const l = await line(bonusMonth);
    expect(Number(l.paye)).toBe(8009);
    expect(Number(l.taxable_income)).toBe(42_800);
    // The breakdown keeps each component's SARS code, so later readers classify by it.
    expect((l.component_breakdown as Array<{ sarsSourceCode: string }>).map(c => c.sarsSourceCode).sort()).toEqual(['3601', '3605']);
    const { rows } = await pool.query('SELECT SUM(paye)::numeric AS paye FROM payroll_run_lines WHERE run_id=$1', [run]);
    expect(summary.totalPaye).toBe(Number(rows[0].paye));
  });

  it('a bonus with no regular pay: 3 780.00', async () => {
    await calculatePayrollRun(run, company);
    expect(Number((await line(bonusOnly)).paye)).toBe(3780);
  });

  it('under the threshold until the bonus: 2 700.00', async () => {
    await calculatePayrollRun(run, company);
    expect(Number((await line(underThreshold)).paye)).toBe(2700);
  });

  it('final run: leave pay-out and notice pay taxed as annual payments, 2 515.20 + 7 800.00', async () => {
    await calculatePayrollRun(run, company);
    const l = await line(leaver);
    expect(Number(l.gross_pay)).toBe(51_670);
    expect(Number(l.paye)).toBe(10_315.2);
  });
});
