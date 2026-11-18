/**
 * Employee loan module — amortisation, fringe benefit, per-run deduction.
 *
 * Amortisation methods:
 *   - declining_balance : equal installment every period; interest on
 *                         opening balance, principal = installment - interest.
 *   - straight_line     : equal principal every period; interest on opening.
 *   - interest_free     : principal only, zero interest. Fringe benefit may
 *                         still apply if official rate > 0.
 *
 * Fringe benefit (Seventh Schedule §7): if loan interest rate < official
 * SARS rate (REPO+1% on the loan start date), the difference * opening
 * balance / 12 is taxable. Captured on payroll_loan_payments.fringe_benefit.
 *
 * Integration with payrollCalculator happens via applyLoanToRun(), called
 * once per (employee, run). Returns the deductible principal + interest and
 * any fringe benefit so the caller can emit component lines (principal +
 * interest as deduction, fringe as SARS 3801 income).
 */

import { assertFrequencyTermsAssignable } from './payrollFrequencyGuard';
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockCompanyPayrollApprovals } from './payrollRunLock';
import {
  buildSchedule, LoanClosedError, LoanNotFoundError,
  type LoanMethod, type LoanPayment, type LoanScheduleRow, type LoanStatus, type PayrollLoan,
} from './payrollLoanSchedule';

export * from './payrollLoanSchedule';
export * from './payrollLoanApply';
export * from './payrollLoanDue';

type Row = DbRow;

function mapLoan(r: Row): PayrollLoan {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeId: String(r.employee_id),
    loanNumber: String(r.loan_number),
    description: String(r.description),
    principal: Number(r.principal),
    annualInterestRate: Number(r.annual_interest_rate),
    termMonths: Number(r.term_months),
    method: r.method as LoanMethod,
    startDate: r.start_date instanceof Date ? r.start_date : new Date(String(r.start_date)),
    firstPeriodYear: Number(r.first_deduction_period_year),
    firstPeriodMonth: Number(r.first_deduction_period_month),
    status: r.status as LoanStatus,
    outstandingBalance: Number(r.outstanding_balance),
    totalInterestCharged: Number(r.total_interest_charged ?? 0),
    totalPrincipalPaid: Number(r.total_principal_paid ?? 0),
    notes: r.notes == null ? null : String(r.notes),
    createdBy: r.created_by == null ? null : String(r.created_by),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(String(r.updated_at)),
    settledAt: r.settled_at == null ? null : r.settled_at instanceof Date ? r.settled_at : new Date(String(r.settled_at)),
  };
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  if (rows.length === 0) {
    throw new Error(`Payroll employee ${employeeId} not found in company`);
  }
}

export interface CreateLoanInput {
  companyId: string;
  employeeId: string;
  loanNumber: string;
  description: string;
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  method: LoanMethod;
  startDate: Date;
  firstPeriodYear: number;
  firstPeriodMonth: number;
  notes?: string;
  userId: string;
}

export async function createLoan(input: CreateLoanInput): Promise<PayrollLoan> {
  await assertEmployeeInCompany(input.companyId, input.employeeId);
  await assertFrequencyTermsAssignable(input.companyId, input.employeeId, 'a loan'); // wave 6 FQc, §0a.11
  if (input.principal <= 0) throw new Error('principal must be > 0');
  if (input.termMonths < 1) throw new Error('termMonths must be >= 1');

  log.info(
    'Creating payroll loan',
    {
      companyId: input.companyId,
      employeeId: input.employeeId,
      loanNumber: input.loanNumber,
      principal: input.principal,
      termMonths: input.termMonths,
      method: input.method,
    },
    'payrollLoanService',
  );

  const rows = (await sql`
    INSERT INTO payroll_loans (
      company_id, employee_id, loan_number, description, principal,
      annual_interest_rate, term_months, method, start_date,
      first_deduction_period_year, first_deduction_period_month,
      outstanding_balance, notes, created_by
    ) VALUES (
      ${input.companyId}::uuid,
      ${input.employeeId}::uuid,
      ${input.loanNumber},
      ${input.description},
      ${input.principal},
      ${input.annualInterestRate},
      ${input.termMonths},
      ${input.method},
      ${input.startDate.toISOString().slice(0, 10)},
      ${input.firstPeriodYear},
      ${input.firstPeriodMonth},
      ${input.principal},
      ${input.notes ?? null},
      ${input.userId}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('Loan INSERT returned no row');
  const loan = mapLoan(rows[0]);

  const schedule = buildSchedule({
    principal: input.principal,
    annualInterestRate: input.annualInterestRate,
    termMonths: input.termMonths,
    method: input.method,
    firstPeriodYear: input.firstPeriodYear,
    firstPeriodMonth: input.firstPeriodMonth,
  });

  for (const row of schedule) {
    await sql`
      INSERT INTO payroll_loan_schedule (
        loan_id, sequence, due_period_year, due_period_month,
        opening_balance, interest, principal, installment, closing_balance
      ) VALUES (
        ${loan.id}::uuid,
        ${row.sequence},
        ${row.duePeriodYear},
        ${row.duePeriodMonth},
        ${row.openingBalance},
        ${row.interest},
        ${row.principal},
        ${row.installment},
        ${row.closingBalance}
      )
    `;
  }

  return loan;
}

export async function listLoans(companyId: string, opts: { status?: LoanStatus; employeeId?: string } = {}): Promise<PayrollLoan[]> {
  const rows = (await sql`
    SELECT * FROM payroll_loans
     WHERE company_id = ${companyId}::uuid
       AND (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null}::text)
       AND (${opts.employeeId ?? null}::uuid IS NULL OR employee_id = ${opts.employeeId ?? null}::uuid)
     ORDER BY created_at DESC
  `) as Row[];
  return rows.map(mapLoan);
}

export async function getLoan(companyId: string, loanId: string): Promise<{
  loan: PayrollLoan;
  schedule: LoanScheduleRow[];
  payments: LoanPayment[];
}> {
  const loanRows = (await sql`
    SELECT * FROM payroll_loans
     WHERE id = ${loanId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  if (!loanRows[0]) throw new LoanNotFoundError(loanId);

  const loan = mapLoan(loanRows[0]);

  const scheduleRows = (await sql`
    SELECT * FROM payroll_loan_schedule
     WHERE loan_id = ${loanId}::uuid
     ORDER BY sequence
  `) as Row[];

  const paymentRows = (await sql`
    SELECT * FROM payroll_loan_payments
     WHERE loan_id = ${loanId}::uuid
     ORDER BY period_year, period_month
  `) as Row[];

  return {
    loan,
    schedule: scheduleRows.map(r => ({
      id: String(r.id),
      loanId: String(r.loan_id),
      sequence: Number(r.sequence),
      duePeriodYear: Number(r.due_period_year),
      duePeriodMonth: Number(r.due_period_month),
      openingBalance: Number(r.opening_balance),
      interest: Number(r.interest),
      principal: Number(r.principal),
      installment: Number(r.installment),
      closingBalance: Number(r.closing_balance),
      paidFlag: r.paid_flag === true,
    })),
    payments: paymentRows.map(r => ({
      id: String(r.id),
      loanId: String(r.loan_id),
      runId: r.run_id == null ? null : String(r.run_id),
      periodYear: Number(r.period_year),
      periodMonth: Number(r.period_month),
      openingBalance: Number(r.opening_balance),
      interestCharged: Number(r.interest_charged),
      principalPaid: Number(r.principal_paid),
      fringeBenefit: Number(r.fringe_benefit),
      closingBalance: Number(r.closing_balance),
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
    })),
  };
}

export async function closeLoan(
  companyId: string,
  loanId: string,
  status: 'settled' | 'written_off' | 'cancelled',
  userId: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    await lockCompanyPayrollApprovals(null, companyId, tx);
    const rows = (await tx`
      SELECT id, status FROM payroll_loans
       WHERE id = ${loanId}::uuid AND company_id = ${companyId}::uuid
       LIMIT 1
       FOR UPDATE
    `) as Row[];
    const row = rows[0];
    if (!row) throw new LoanNotFoundError(loanId);
    if (row.status !== 'active') throw new LoanClosedError(row.status as LoanStatus);

    await tx`
      UPDATE payroll_loans
         SET status = ${status},
             settled_at = NOW(),
             updated_at = NOW()
       WHERE id = ${loanId}::uuid
    `;
  });

  log.info('Loan closed', { companyId, loanId, status, userId }, 'payrollLoanService');
}
