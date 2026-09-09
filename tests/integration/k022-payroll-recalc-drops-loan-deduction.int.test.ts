// K-022 RED: recalculating a payroll run drops the loan repayment deduction
// while keeping the reduced loan balance.
//
// applyLoanToRun marks the schedule row paid_flag = true and decrements
// payroll_loans.outstanding_balance on the FIRST calculation. calculatePayrollRun
// deletes and rebuilds payroll_run_lines on every call, but the second call's
// schedule lookup filters `paid_flag = false` and finds nothing, so
// applyLoanToRun returns null and no LOAN deduction is injected. The employee is
// paid the repayment back while the loan still reads as repaid.
// Source: src/modules/accounting/services/payroll/payrollLoanService.ts:400-464
//         src/modules/accounting/services/payroll/payrollRunService.ts:176-191, 251-254
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const employee = crypto.randomUUID();
const salaryComp = crypto.randomUUID();
const loanComp = crypto.randomUUID();
const run = crypto.randomUUID();
const loan = crypto.randomUUID();

// A second tenant, whose single instalment settles the loan outright. Proves
// the reversal is company-scoped and that it restores a settled loan to active
// so the forward path can settle it again.
const otherCompany = crypto.randomUUID();
const otherEmployee = crypto.randomUUID();
const otherSalaryComp = crypto.randomUUID();
const otherLoanComp = crypto.randomUUID();
const otherRun = crypto.randomUUID();
const otherLoan = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K022 payroll fixture']);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
     VALUES($1,$2,'K022-1','Lerato','Mokoena',DATE '2020-01-01','active')`,
    [employee, company],
  );
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
     VALUES($1,$3,'Basic salary','3601','earning',true,true,true),
           ($2,$3,'Loan repayment','LOAN','deduction',false,false,false)`,
    [salaryComp, loanComp, company],
  );
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
     VALUES($1,$2,20000,DATE '2020-01-01')`,
    [employee, salaryComp],
  );
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,3,2026,'draft')`,
    [run, company],
  );
  // Interest rate equals the SARS official rate, so there is no fringe benefit
  // and the repayment is pure principal.
  await pool.query(
    `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
       annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
       first_deduction_period_month,status,outstanding_balance)
     VALUES($1,$2,$3,'K022-LOAN-1','Staff loan',12000,0.085,12,'straight_line',
       DATE '2026-03-01',2026,3,'active',10000)`,
    [loan, company, employee],
  );
  await pool.query(
    `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
       opening_balance,interest,principal,installment,closing_balance,paid_flag)
     VALUES($1,1,2026,3,10000,0,1000,1000,9000,false)`,
    [loan],
  );

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K022 other tenant']);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
     VALUES($1,$2,'K022-2','Sipho','Dlamini',DATE '2020-01-01','active')`,
    [otherEmployee, otherCompany],
  );
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
     VALUES($1,$3,'Basic salary','3601','earning',true,true,true),
           ($2,$3,'Loan repayment','LOAN','deduction',false,false,false)`,
    [otherSalaryComp, otherLoanComp, otherCompany],
  );
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
     VALUES($1,$2,20000,DATE '2020-01-01')`,
    [otherEmployee, otherSalaryComp],
  );
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,3,2026,'draft')`,
    [otherRun, otherCompany],
  );
  await pool.query(
    `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
       annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
       first_deduction_period_month,status,outstanding_balance)
     VALUES($1,$2,$3,'K022-LOAN-2','Final instalment',1000,0.085,1,'straight_line',
       DATE '2026-03-01',2026,3,'active',1000)`,
    [otherLoan, otherCompany, otherEmployee],
  );
  await pool.query(
    `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
       opening_balance,interest,principal,installment,closing_balance,paid_flag)
     VALUES($1,1,2026,3,1000,0,1000,1000,0,false)`,
    [otherLoan],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_loan_payments WHERE loan_id=$1', [loan]);
    await pool.query('DELETE FROM payroll_loan_schedule WHERE loan_id=$1', [loan]);
    await pool.query('DELETE FROM payroll_loans WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=$1', [employee]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM payroll_loan_payments WHERE loan_id=$1', [otherLoan]);
    await pool.query('DELETE FROM payroll_loan_schedule WHERE loan_id=$1', [otherLoan]);
    await pool.query('DELETE FROM payroll_loans WHERE company_id=$1', [otherCompany]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [otherRun]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [otherCompany]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=$1', [otherEmployee]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [otherCompany]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [otherCompany]);
    await pool.query('DELETE FROM companies WHERE id=$1', [otherCompany]);
  } finally {
    await pool.end();
  }
});

async function snapshot(runId = run, loanId = loan) {
  const line = await pool.query(
    'SELECT gross_pay, net_pay, component_breakdown FROM payroll_run_lines WHERE run_id=$1', [runId]);
  const l = await pool.query(
    'SELECT outstanding_balance, total_principal_paid, status FROM payroll_loans WHERE id=$1', [loanId]);
  const breakdown = line.rows[0].component_breakdown as Array<Record<string, unknown>>;
  return {
    netPay: Number(line.rows[0].net_pay),
    loanDeduction: breakdown
      .filter((c) => String(c.sarsSourceCode ?? c.sars_source_code ?? '') === 'LOAN')
      .reduce((s, c) => s + Number(c.amount ?? 0), 0),
    outstanding: Number(l.rows[0].outstanding_balance),
    principalPaid: Number(l.rows[0].total_principal_paid),
    status: String(l.rows[0].status),
  };
}

describe('K-022 payroll recalculation and loan repayment', () => {
  it('keeps the loan deduction and the loan balance consistent across a recalculation', async () => {
    await calculatePayrollRun(run, company);
    const first = await snapshot();
    expect(first.loanDeduction).toBe(1000);
    expect(first.outstanding).toBe(9000);
    expect(first.principalPaid).toBe(1000);

    await calculatePayrollRun(run, company);
    const second = await snapshot();

    // A recalculation with no input change must reproduce the same payslip and
    // must not leave the loan reading as repaid without a deduction.
    expect(second).toEqual(first);

    // Exactly one payment row survives the recalculation, so the audit trail
    // matches the balance the loan reports.
    const payments = await pool.query(
      'SELECT run_id, principal_paid FROM payroll_loan_payments WHERE loan_id=$1', [loan]);
    expect(payments.rowCount).toBe(1);
    expect(Number(payments.rows[0].principal_paid)).toBe(1000);
    expect(String(payments.rows[0].run_id)).toBe(run);
  });

  it('reduces the outstanding balance exactly once across three calculations', async () => {
    await calculatePayrollRun(run, company);
    const third = await snapshot();
    expect(third.loanDeduction).toBe(1000);
    expect(third.netPay).toBe(17003.80);
    expect(third.outstanding).toBe(9000);
    expect(third.principalPaid).toBe(1000);

    const schedule = await pool.query(
      'SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id=$1', [loan]);
    expect(schedule.rows[0].paid_flag).toBe(true);
  });

  it('refuses to recalculate — and so cannot reverse — an approved run', async () => {
    await pool.query("UPDATE payroll_run_headers SET status='approved' WHERE id=$1", [run]);
    try {
      await expect(calculatePayrollRun(run, company)).rejects.toBeInstanceOf(PayrollRunLockedError);

      const locked = await snapshot();
      expect(locked.loanDeduction).toBe(1000);
      expect(locked.outstanding).toBe(9000);
      expect(locked.principalPaid).toBe(1000);
      const payments = await pool.query(
        'SELECT id FROM payroll_loan_payments WHERE loan_id=$1', [loan]);
      expect(payments.rowCount).toBe(1);
    } finally {
      await pool.query("UPDATE payroll_run_headers SET status='draft' WHERE id=$1", [run]);
    }
  });

  it('leaves another tenant\'s loan alone and re-settles a loan the reversal reopened', async () => {
    await calculatePayrollRun(otherRun, otherCompany);
    const otherFirst = await snapshot(otherRun, otherLoan);
    expect(otherFirst.loanDeduction).toBe(1000);
    expect(otherFirst.outstanding).toBe(0);
    expect(otherFirst.status).toBe('settled');

    // Recalculating THIS company's run must not touch the other tenant.
    await calculatePayrollRun(run, company);
    expect(await snapshot(otherRun, otherLoan)).toEqual(otherFirst);
    const otherPayments = await pool.query(
      'SELECT id FROM payroll_loan_payments WHERE loan_id=$1', [otherLoan]);
    expect(otherPayments.rowCount).toBe(1);

    // And recalculating the other run reopens then re-settles its own loan.
    await calculatePayrollRun(otherRun, otherCompany);
    expect(await snapshot(otherRun, otherLoan)).toEqual(otherFirst);
  });
});
