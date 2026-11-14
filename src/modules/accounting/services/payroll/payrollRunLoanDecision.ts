import { formatMoney } from '@/lib/money/formatMoney';
import { calculatePayrollLine } from './payrollCalculator';
import { appendLoanComponents, fringeOnlyLoanApplications, type LoanComponents } from './payrollRunLoanComponents';
import type { ApplyLoanResult } from './payrollLoanService';
import type { RegularPayDirectiveState } from './directiveRegularPay';
import type {
  EmployeeComponent, PayeYearToDate, PayrollEmployee, PayrollPeriod, ValidationResult,
} from './payrollTypes';

export interface LoanLineBasis {
  employee: PayrollEmployee;
  components: EmployeeComponent[];
  /** The same directive the stored line is costed with (DR), so the preview's PAYE is the line's. */
  regularPayDirective?: RegularPayDirectiveState;
}

export function judgeLoanApplications(input: {
  basis: LoanLineBasis | undefined;
  applications: ApplyLoanResult[];
  loanComponents: LoanComponents;
  period: PayrollPeriod;
  taxYear: number;
  ytd?: PayeYearToDate;
}): { allowed: boolean; rawNet: number } {
  if (!input.basis) {
    return { allowed: false, rawNet: -input.applications.reduce((sum, app) => sum + app.installment, 0) };
  }
  const benefitOnly = calculatePayrollLine({
    employee: input.basis.employee,
    components: appendLoanComponents(
      input.basis.components, fringeOnlyLoanApplications(input.applications), input.loanComponents,
    ),
    period: input.period, taxYear: input.taxYear, annualPayrollEstimate: 'defer', ytd: input.ytd,
    regularPayDirective: input.basis.regularPayDirective,
  });
  const availableCents = Math.round(Math.max(0, benefitOnly.netPay) * 100);
  const deductionCents = Math.round(input.applications.reduce((sum, app) => sum + app.principal + app.interest, 0) * 100);
  return { allowed: deductionCents <= availableCents, rawNet: (availableCents - deductionCents) / 100 };
}

export function blockedLoanValidation(
  applications: ApplyLoanResult[],
  rawNet: number,
  employeeName: string,
): ValidationResult {
  const loans = applications.map((app) => app.loanNumber);
  const instalment = applications.reduce((sum, app) => sum + app.installment, 0);
  return {
    code: 'LOAN_INSTALMENT_EXCEEDS_PAY', severity: 'error', rawNet, loans,
    message: `${loans.length > 1 ? 'Loan instalments' : `Loan ${loans[0] ?? ''} instalment`} for ${employeeName} totalling ${formatMoney(instalment)} exceed available pay. `
      + 'This payslip is blocked for manual review. No loan payment was taken and the loan balance is unchanged.',
  };
}
