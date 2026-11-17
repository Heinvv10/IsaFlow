/** Employee loan types, errors and the amortisation schedule (moved out of payrollLoanService.ts, unchanged). */

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

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The month's low-interest-loan fringe benefit (Seventh Schedule §7): the rate shortfall on the opening balance. */
export function fringeBenefitOf(officialRate: number, loanRate: number, opening: number): number {
  return round2((Math.max(0, officialRate - loanRate) * opening) / 12);
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
