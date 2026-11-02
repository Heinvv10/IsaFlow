/**
 * The approval gate's refusals read off a run's stored lines (payrollApprovalGate step 3), in order:
 * a pre-code line that cannot be judged, a loan payment its payslip does not show, a loan withheld
 * for want of a LOAN deduction or a 3801 earning, then a shortfall the loan instalment alone does
 * not cause. A shortfall it does cause is only an advisory
 * (owner decision, the module's .claude.md).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { OverdrawnLine, WithheldLoanLine } from './payrollRunLines';

export const overdrawnNames = (lines: OverdrawnLine[]) =>
  lines.map((l) => `${l.employeeNumber} (${formatMoney(l.shortfall)} over)`).join(', ');

export function lineBlocker(
  overdrawn: OverdrawnLine[],
  withheld: WithheldLoanLine[],
  offPayslip: Array<{ employeeNumber: string; loanNumber: string }>,
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
      detail: `Loan payments this run recorded are not on the payslip of ${offPayslip.map((p) => `${p.employeeNumber} (loan ${p.loanNumber})`).join('; ')}: `
        + 'it was calculated when a missing loan component was skipped. Recalculate this run.',
    };
  }
  for (const [missing, code, component] of [
    ['deduction', 'loan_deduction_missing', 'deduction is coded LOAN'],
    ['fringe', 'loan_fringe_component_missing', 'earning is coded 3801 for the low-interest fringe benefit'],
  ] as const) {
    const lines = withheld.filter((w) => w.missing === missing);
    if (lines.length === 0) continue;
    return {
      code,
      detail: `Loan instalments were not taken for ${lines.map((w) => `${w.employeeNumber} (loan ${w.loans.join(', ')})`).join('; ')}: `
        + `no active ${component}, so nothing was deducted and the loans are unchanged. `
        + 'Add it under Setup → Pay Components, then recalculate.',
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
