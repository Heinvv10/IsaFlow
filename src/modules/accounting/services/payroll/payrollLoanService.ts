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

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export type LoanMethod = 'declining_balance' | 'straight_line' | 'interest_free';
export type LoanStatus = 'active' | 'settled' | 'written_off' | 'cancelled';

export interface PayrollLoan {
  id: string;
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
  status: LoanStatus;
  outstandingBalance: number;
  totalInterestCharged: number;
  totalPrincipalPaid: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  settledAt: Date | null;
}

export interface LoanScheduleRow {
  id?: string;
  loanId?: string;
  sequence: number;
  duePeriodYear: number;
  duePeriodMonth: number;
  openingBalance: number;
  interest: number;
  principal: number;
  installment: number;
  closingBalance: number;
  paidFlag?: boolean;
}

export interface LoanPayment {
  id: string;
  loanId: string;
  runId: string | null;
  periodYear: number;
  periodMonth: number;
  openingBalance: number;
  interestCharged: number;
  principalPaid: number;
  fringeBenefit: number;
  closingBalance: number;
  createdAt: Date;
}

export class LoanNotFoundError extends Error {
  constructor(id: string) {
    super(`Loan ${id} not found`);
    this.name = 'LoanNotFoundError';
  }
}
export class LoanClosedError extends Error {
  constructor(status: LoanStatus) {
    super(`Loan is ${status} — reopen is not supported; create a new loan.`);
    this.name = 'LoanClosedError';
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BuildScheduleInput {
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  method: LoanMethod;
  firstPeriodYear: number;
  firstPeriodMonth: number;
}

export function buildSchedule(input: BuildScheduleInput): LoanScheduleRow[] {
  const { principal, termMonths, method, firstPeriodYear, firstPeriodMonth } = input;
  const monthlyRate = input.annualInterestRate / 12;

  const rows: LoanScheduleRow[] = [];
  let balance = principal;
  let year = firstPeriodYear;
  let month = firstPeriodMonth;

  const decliningInstallment =
    method === 'declining_balance' && monthlyRate > 0
      ? (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths))
      : principal / termMonths;

  const straightPrincipal = principal / termMonths;

  for (let seq = 1; seq <= termMonths; seq++) {
    const opening = balance;
    let interest = 0;
    let principalPortion = 0;

    if (method === 'declining_balance') {
      interest = opening * monthlyRate;
      principalPortion = decliningInstallment - interest;
    } else if (method === 'straight_line') {
      interest = opening * monthlyRate;
      principalPortion = straightPrincipal;
    } else {
      interest = 0;
      principalPortion = straightPrincipal;
    }

    if (seq === termMonths) {
      principalPortion = opening;
    }

    const installment = principalPortion + interest;
    const closing = opening - principalPortion;

    rows.push({
      sequence: seq,
      duePeriodYear: year,
      duePeriodMonth: month,
      openingBalance: round2(opening),
      interest: round2(interest),
      principal: round2(principalPortion),
      installment: round2(installment),
      closingBalance: round2(Math.max(0, closing)),
    });

    balance = closing;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return rows;
}

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
  if (input.principal <= 0) throw new Error('principal must be > 0');
  if (input.termMonths < 1) throw new Error('termMonths must be >= 1');

  log.info(
    'Creating payroll loan',
    {
      companyId: input.companyId,
      employeeId: input.employeeId,
      loanNumber: input.loanNumber,
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

export interface ApplyLoanToRunInput {
  loanId: string;
  companyId: string;
  runId: string;
  periodYear: number;
  periodMonth: number;
  /** SARS official rate (REPO+1%) used to compute fringe benefit. */
  officialRate: number;
}

export interface ApplyLoanResult {
  loanId: string;
  employeeId: string;
  scheduleRowId: string;
  interest: number;
  principal: number;
  installment: number;
  fringeBenefit: number;
  openingBalance: number;
  closingBalance: number;
}

export async function applyLoanToRun(input: ApplyLoanToRunInput): Promise<ApplyLoanResult | null> {
  const loanRows = (await sql`
    SELECT id, company_id, employee_id, status, outstanding_balance,
           total_interest_charged, total_principal_paid,
           method, annual_interest_rate
      FROM payroll_loans
     WHERE id = ${input.loanId}::uuid AND company_id = ${input.companyId}::uuid
     LIMIT 1
  `) as Row[];
  const loanRow = loanRows[0];
  if (!loanRow || loanRow.status !== 'active') return null;

  const scheduleRows = (await sql`
    SELECT id, sequence, opening_balance, interest, principal, installment, closing_balance
      FROM payroll_loan_schedule
     WHERE loan_id = ${input.loanId}::uuid
       AND due_period_year = ${input.periodYear}
       AND due_period_month = ${input.periodMonth}
       AND paid_flag = false
     LIMIT 1
  `) as Row[];
  const scheduleRow = scheduleRows[0];
  if (!scheduleRow) return null;

  const interest = Number(scheduleRow.interest);
  const principal = Number(scheduleRow.principal);
  const installment = Number(scheduleRow.installment);
  const opening = Number(scheduleRow.opening_balance);
  const closing = Number(scheduleRow.closing_balance);

  const loanRate = Number(loanRow.annual_interest_rate);
  const rateShortfall = Math.max(0, input.officialRate - loanRate);
  const fringeBenefit = round2((rateShortfall * opening) / 12);

  await sql`
    INSERT INTO payroll_loan_payments (
      loan_id, run_id, period_year, period_month,
      opening_balance, interest_charged, principal_paid, fringe_benefit, closing_balance
    ) VALUES (
      ${input.loanId}::uuid,
      ${input.runId}::uuid,
      ${input.periodYear},
      ${input.periodMonth},
      ${opening},
      ${interest},
      ${principal},
      ${fringeBenefit},
      ${closing}
    )
    ON CONFLICT (loan_id, period_year, period_month) DO UPDATE SET
      opening_balance = EXCLUDED.opening_balance,
      interest_charged = EXCLUDED.interest_charged,
      principal_paid = EXCLUDED.principal_paid,
      fringe_benefit = EXCLUDED.fringe_benefit,
      closing_balance = EXCLUDED.closing_balance,
      run_id = EXCLUDED.run_id
  `;

  await sql`
    UPDATE payroll_loan_schedule
       SET paid_flag = true
     WHERE id = ${String(scheduleRow.id)}::uuid
  `;

  const newBalance = round2(Math.max(0, Number(loanRow.outstanding_balance) - principal));
  const newStatus: LoanStatus = newBalance <= 0.0001 ? 'settled' : 'active';

  await sql`
    UPDATE payroll_loans
       SET outstanding_balance = ${newBalance},
           total_interest_charged = total_interest_charged + ${interest},
           total_principal_paid = total_principal_paid + ${principal},
           status = ${newStatus},
           settled_at = CASE WHEN ${newStatus} = 'settled' THEN NOW() ELSE settled_at END,
           updated_at = NOW()
     WHERE id = ${input.loanId}::uuid
  `;

  log.info(
    'Loan payment applied',
    {
      companyId: input.companyId,
      loanId: input.loanId,
      periodYear: input.periodYear,
      periodMonth: input.periodMonth,
    },
    'payrollLoanService',
  );

  return {
    loanId: input.loanId,
    employeeId: String(loanRow.employee_id),
    scheduleRowId: String(scheduleRow.id),
    interest,
    principal,
    installment,
    fringeBenefit,
    openingBalance: opening,
    closingBalance: closing,
  };
}

export async function closeLoan(
  companyId: string,
  loanId: string,
  status: 'settled' | 'written_off' | 'cancelled',
  userId: string,
): Promise<void> {
  const rows = (await sql`
    SELECT id, status FROM payroll_loans
     WHERE id = ${loanId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) throw new LoanNotFoundError(loanId);
  if (row.status !== 'active') throw new LoanClosedError(row.status as LoanStatus);

  await sql`
    UPDATE payroll_loans
       SET status = ${status},
           settled_at = NOW(),
           updated_at = NOW()
     WHERE id = ${loanId}::uuid
  `;

  log.info('Loan closed', { companyId, loanId, status, userId }, 'payrollLoanService');
}

export async function listActiveLoansForRun(
  companyId: string,
  periodYear: number,
  periodMonth: number,
): Promise<Array<{ loanId: string; employeeId: string }>> {
  const rows = (await sql`
    SELECT DISTINCT l.id AS loan_id, l.employee_id
      FROM payroll_loans l
      JOIN payroll_loan_schedule s ON s.loan_id = l.id
     WHERE l.company_id = ${companyId}::uuid
       AND l.status = 'active'
       AND s.paid_flag = false
       AND s.due_period_year = ${periodYear}
       AND s.due_period_month = ${periodMonth}
  `) as Row[];
  return rows.map(r => ({ loanId: String(r.loan_id), employeeId: String(r.employee_id) }));
}
