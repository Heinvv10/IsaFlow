/**
 * The approval gate's refusals read off a run's stored lines (payrollApprovalGate step 3), in order:
 * a pre-code line that cannot be judged, an instalment no LOAN deduction could take, then a
 * shortfall the loan instalment alone does not cause. A shortfall it does cause is only an advisory
 * (owner decision, the module's .claude.md).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { OverdrawnLine } from './payrollRunLines';

export const overdrawnNames = (lines: OverdrawnLine[]) =>
  lines.map((l) => `${l.employeeNumber} (${formatMoney(l.shortfall)} over)`).join(', ');

export function lineBlocker(
  overdrawn: OverdrawnLine[],
  withheld: Array<{ employeeNumber: string; loans: string[] }>,
): PayrollJournalNote | null {
  const unreadable = overdrawn.filter((l) => l.unreadable);
  if (unreadable.length > 0) {
    return {
      code: 'run_lines_unreadable',
      detail: `The stored lines of ${unreadable.map((l) => l.employeeNumber).join(', ')} pay nil and their breakdown cannot be read, `
        + 'so nothing shows whether their deductions exceed their pay. Recalculate this run.',
    };
  }
  if (withheld.length > 0) {
    return {
      code: 'loan_deduction_missing',
      detail: `Loan instalments were not taken for ${withheld.map((w) => `${w.employeeNumber} (loan ${w.loans.join(', ')})`).join('; ')}: `
        + 'no active deduction is coded LOAN, so nothing was deducted and the loans are unchanged. '
        + 'Add one under Setup → Pay Components, then recalculate.',
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
