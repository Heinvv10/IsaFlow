/**
 * The approval gate's refusals read off a run's stored lines (payrollApprovalGate step 3), in order:
 * a pre-code line that cannot be judged, a loan payment its payslip does not show as it must, a loan
 * withheld for want of a LOAN deduction, then a shortfall the loan instalment alone does not cause.
 * A fringe benefit no 3801 earning carries is a line warning, not a refusal (Hein). A shortfall it does cause is only an advisory
 * (owner decision, the module's .claude.md).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { LoanPaymentOnPayslip, OverdrawnLine, WithheldLoanLine } from './payrollRunLines';

export const overdrawnNames = (lines: OverdrawnLine[]) =>
  lines.map((l) => `${l.employeeNumber} (${formatMoney(l.shortfall)} over)`).join(', ');

export function lineBlocker(
  overdrawn: OverdrawnLine[],
  withheld: WithheldLoanLine[],
  offPayslip: LoanPaymentOnPayslip[],
): PayrollJournalNote | null {
  const unreadable = overdrawn.filter((l) => l.unreadable);
  if (unreadable.length > 0) {
    return {
      code: 'run_lines_unreadable',
      detail: `The stored lines of ${unreadable.map((l) => l.employeeNumber).join(', ')} pay nil and their breakdown cannot be read, `
        + 'so nothing shows whether their deductions exceed their pay. Recalculate this run.',
    };
  }
  if (offPayslip.length > 0) {
    return {
      code: 'loan_payments_off_payslip',
      detail: `Loan payments this run recorded are not on the payslip of ${offPayslip.map((p) => `${p.employeeNumber} (loan ${p.loanNumber})`).join('; ')} `
        + 'as a non-taxable LOAN deduction or a 3801 earning of that amount: it was calculated before loan components were checked. '
        + 'Recalculate this run.',
    };
  }
  if (withheld.length > 0) {
    return {
      code: 'loan_deduction_missing',
      detail: `Loan instalments were not taken for ${withheld.map((w) => `${w.employeeNumber} (loan ${w.loans.join(', ')})`).join('; ')}: `
        + `no active deduction is coded LOAN${withheld.some((w) => w.fringeToo) ? ', nor an earning coded 3801 for the fringe benefit' : ''}, `
        + 'so nothing was deducted and the loans are unchanged. Add the missing components under Setup → Pay Components, then recalculate.',
    };
  }
  const blocked = overdrawn.filter((l) => !l.fromLoan);
  if (blocked.length === 0) return null;
  return {
    code: 'deductions_exceed_pay',
    detail: `Deductions and tax exceed pay for ${overdrawnNames(blocked)}: net pay would be nil and the deductions payable understated. `
      + 'Reduce or end those deductions on the employee page, or add to the pay, then recalculate.',
  };
}

/** Loans collected with a fringe benefit no 3801 earning carries (Hein: a warning): told to the approver. */
export function fringeAdvisory(lines: LoanPaymentOnPayslip[]): PayrollJournalNote[] {
  if (lines.length === 0) return [];
  return [{
    code: 'loan_fringe_not_recorded',
    detail: `The low-interest fringe benefit of ${lines.map((l) => `${l.employeeNumber} (loan ${l.loanNumber})`).join('; ')} is not on the payslip `
      + 'and was not taxed: no 3801 earning carried it. Add one under Setup → Pay Components and recalculate to record it.',
  }];
}
