/**
 * Audit 2026-10-18 P4, review round 1: edges of the run population that
 * p4-leaver-in-final-run.int.test.ts does not reach.
 *
 *   - an employee starting after the period is not in it;
 *   - a leaver outside the run has no loan instalment taken (no payslip would
 *     carry the deduction);
 *   - an end date moved into a later month after an approved run paid the
 *     termination pay-outs does not pay them a second time;
 *   - month boundaries: an end date on the 1st, one in the next month for an
 *     active, terminated (run recalculated after they left) or inactive
 *     employee, and December → January.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { setTerminationDetails } from '@/modules/accounting/services/payroll/payrollTerminationService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const janCompany = crypto.randomUUID();
const salary = crypto.randomUUID();
const janSalary = crypto.randomUUID();
const marchRun = crypto.randomUUID();
const febRun = crypto.randomUUID();
const janRun = crypto.randomUUID();
const loan = crypto.randomUUID();

const stayer = crypto.randomUUID();
const futureStarter = crypto.randomUUID();
const staleWithLoan = crypto.randomUUID();
const movedEnd = crypto.randomUUID();
const leftFirst = crypto.randomUUID();
const leftInApril = crypto.randomUUID();
const leavingApril1 = crypto.randomUUID();
const inactiveLater = crypto.randomUUID();
const leftDec31 = crypto.randomUUID();
const leftJan1 = crypto.randomUUID();

const MONTHLY = 20000;

async function addEmployee(
  id: string, companyId: string, num: string,
  start: string, end: string | null, status: string,
) {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,end_date,status)
     VALUES($1,$2,$3,'Edge',$3,$4::date,$5::date,$6)`,
    [id, companyId, num, start, end, status],
  );
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
     VALUES($1,$2,$3,DATE '2020-01-01')`,
    [id, companyId === company ? salary : janSalary, MONTHLY],
  );
}

async function line(runId: string, employeeId: string) {
  const { rows } = await pool.query(
    'SELECT component_breakdown, validation_results FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2',
    [runId, employeeId],
  );
  return rows[0] as
    | { component_breakdown: Array<{ componentId: string }>; validation_results: Array<{ code: string }> }
    | undefined;
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'P4 edges'], [janCompany, 'P4 Dec-Jan']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  for (const [id, companyId] of [[salary, company], [janSalary, janCompany]] as const) {
    await pool.query(
      `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
       VALUES($1,$2,'Basic salary','3601','earning',true,true,true)`,
      [id, companyId],
    );
  }

  await addEmployee(stayer, company, 'E-STAYER', '2020-01-01', null, 'active');
  await addEmployee(futureStarter, company, 'E-FUTURE', '2026-04-01', null, 'active');
  // Left in February with status never flipped, and a loan instalment due in March.
  await addEmployee(staleWithLoan, company, 'E-STALE', '2020-01-01', '2026-02-20', 'active');
  await pool.query(
    `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
       annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
       first_deduction_period_month,status,outstanding_balance)
     VALUES($1,$2,$3,'P4-LOAN','Staff loan',1000,0.085,1,'straight_line',
       DATE '2026-03-01',2026,3,'active',1000)`,
    [loan, company, staleWithLoan],
  );
  await pool.query(
    `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
       opening_balance,interest,principal,installment,closing_balance,paid_flag)
     VALUES($1,1,2026,3,1000,0,1000,1000,0,false)`,
    [loan],
  );

  // Final pay went out in the approved February run; the end date was then
  // corrected into March.
  await addEmployee(movedEnd, company, 'E-MOVED', '2020-01-01', '2026-03-10', 'terminated');
  await setTerminationDetails(company, movedEnd, {
    reason: 'resignation', noticePeriodDays: 30, servedNoticeDays: 0,
    severanceWeeksPerYear: null, includeLeavePayout: true,
  });
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,2,2026,'approved'),($3,$2,3,2026,'draft')`,
    [febRun, company, marchRun],
  );
  await pool.query(
    `INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,net_pay,component_breakdown)
     VALUES($1,$2,47690,47690,$3::jsonb)`,
    [febRun, movedEnd, JSON.stringify([
      { componentId: salary, componentName: 'Basic salary', amount: MONTHLY },
      { componentId: 'synthetic:termination:notice-pay', componentName: 'Notice Pay (Termination)', amount: 27690 },
    ])],
  );

  await addEmployee(leftFirst, company, 'E-FIRST', '2020-01-01', '2026-03-01', 'terminated');
  // The March run recalculated in April, after updatePayrollEmployee terminated them.
  await addEmployee(leftInApril, company, 'E-APR5', '2020-01-01', '2026-04-05', 'terminated');
  await addEmployee(leavingApril1, company, 'E-APR1', '2020-01-01', '2026-04-01', 'active');
  await addEmployee(inactiveLater, company, 'E-INACTIVE', '2020-01-01', '2026-05-31', 'inactive');

  await addEmployee(leftDec31, janCompany, 'E-DEC31', '2020-01-01', '2026-12-31', 'terminated');
  await addEmployee(leftJan1, janCompany, 'E-JAN1', '2020-01-01', '2027-01-01', 'terminated');
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,1,2027,'draft')`,
    [janRun, janCompany],
  );
});

afterAll(async () => {
  const companies = [company, janCompany];
  try {
    await pool.query('DELETE FROM payroll_loan_payment_reversals WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_loan_payments WHERE loan_id=$1', [loan]);
    await pool.query('DELETE FROM payroll_loan_schedule WHERE loan_id=$1', [loan]);
    await pool.query('DELETE FROM payroll_loans WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=ANY($1::uuid[])', [[marchRun, febRun, janRun]]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query(
      `DELETE FROM payroll_employee_components WHERE employee_id IN (
         SELECT id FROM payroll_employees WHERE company_id=ANY($1::uuid[]))`,
      [companies],
    );
    await pool.query('DELETE FROM payroll_components WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=ANY($1::uuid[])', [companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companies]);
  } finally {
    await pool.end();
  }
});

describe('P4 edges: the March 2026 run', () => {
  it('does not include an employee who starts in April', async () => {
    await calculatePayrollRun(marchRun, company);
    expect(await line(marchRun, stayer)).toBeDefined();
    expect(await line(marchRun, futureStarter)).toBeUndefined();
  });

  it('takes no loan instalment from a February leaver who has no line in it', async () => {
    await calculatePayrollRun(marchRun, company);
    expect(await line(marchRun, staleWithLoan)).toBeUndefined();
    const { rows } = await pool.query(
      'SELECT outstanding_balance FROM payroll_loans WHERE id=$1', [loan],
    );
    expect(Number(rows[0].outstanding_balance)).toBe(1000);
    const payments = await pool.query('SELECT 1 FROM payroll_loan_payments WHERE loan_id=$1', [loan]);
    expect(payments.rowCount).toBe(0);
  });

  it('pays a moved end date its salary but not the termination pay-outs February already paid', async () => {
    await calculatePayrollRun(marchRun, company);
    const paid = await line(marchRun, movedEnd);
    expect(paid, 'March leaver missing from the run').toBeDefined();
    expect(paid!.component_breakdown.map(c => c.componentId)).toEqual([salary]);
    expect(paid!.validation_results.map(v => v.code)).toContain('TERMINATION_ALREADY_PAID');
  });
});

describe('P4 edges: month boundaries', () => {
  it('the March run pays a 1 March leaver', async () => {
    await calculatePayrollRun(marchRun, company);
    expect(await line(marchRun, leftFirst)).toBeDefined();
  });

  it('the March run, recalculated after a 5 April leaver was terminated, still pays their March salary', async () => {
    await calculatePayrollRun(marchRun, company);
    const paid = await line(marchRun, leftInApril);
    expect(paid, 'April leaver dropped from the March run').toBeDefined();
    expect(paid!.component_breakdown.map(c => c.componentId)).toEqual([salary]);
  });

  it('the March run pays an active employee leaving on 1 April', async () => {
    await calculatePayrollRun(marchRun, company);
    expect(await line(marchRun, leavingApril1)).toBeDefined();
  });

  it('the March run still leaves out an inactive employee whose end date is in May', async () => {
    await calculatePayrollRun(marchRun, company);
    expect(await line(marchRun, inactiveLater)).toBeUndefined();
  });
});

describe('P4 edges: December → January', () => {
  it('the January 2027 run pays a 1 January leaver and not a 31 December one', async () => {
    await calculatePayrollRun(janRun, janCompany);
    expect(await line(janRun, leftJan1)).toBeDefined();
    expect(await line(janRun, leftDec31)).toBeUndefined();
  });
});
