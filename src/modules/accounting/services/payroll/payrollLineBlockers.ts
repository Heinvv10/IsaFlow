/**
 * The approval gate's refusals read off a run's stored lines (payrollApprovalGate step 3), in order:
 * a pre-code line that cannot be judged, a loan payment its payslip does not show as it must, a loan
 * withheld for want of a LOAN deduction, a fringe benefit no 3801 earning carries, a loan instalment
 * above pay, then any other shortfall. The last two loan cases block until the follow-up PR handles
 * them (Hein, 2026-11-02: a loan cap at final pay, and the benefit taxed as non-cash), since approving
 * either would post a GL or PAYE figure that is wrong.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { LoanPaymentOnPayslip, OverdrawnLine, WithheldLoanLine } from './payrollRunLines';

export const overdrawnNames = (lines: OverdrawnLine[]) =>
  lines.map((l) => `${l.employeeNumber} (${l.loans?.length ? `loan ${l.loans.join(', ')}, ` : ''}${formatMoney(l.shortfall)} over)`).join(', ');

const named = (lines: LoanPaymentOnPayslip[]) => {
  const seen = new Set<string>();
  return lines.filter((l) => !seen.has(`${l.employeeNumber}|${l.loanNumber}`) && seen.add(`${l.employeeNumber}|${l.loanNumber}`))
    .map((l) => `${l.employeeNumber}${l.loanNumber ? ` (loan ${l.loanNumber})` : ''}`).join(', ');
};

export function lineBlocker(
  overdrawn: OverdrawnLine[],
  withheld: WithheldLoanLine[],
  offPayslip: LoanPaymentOnPayslip[],
  fringeNotRecorded: LoanPaymentOnPayslip[],
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
  if (fringeNotRecorded.length > 0) {
    return {
      code: 'loan_fringe_not_recorded',
      detail: `The low-interest fringe benefit of ${named(fringeNotRecorded)} is not on the payslip and was not taxed: no active earning `
        + 'is coded 3801. Add the 3801 earning under Setup → Pay Components, then recalculate.',
    };
  }
  const byLoan = overdrawn.filter((l) => l.fromLoan && !l.unreadable);
  if (byLoan.length > 0) {
    return {
      code: 'loan_instalment_exceeds_pay',
      detail: `The loan instalment exceeds pay for ${overdrawnNames(byLoan)}: net pay would be nil while the loan falls by the whole `
        + 'instalment, so the deductions payable would be understated. Reduce or defer the instalment, close the loan, or pay the '
        + "leaver's final pay first, then recalculate. A cap at final pay is coming.",
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
