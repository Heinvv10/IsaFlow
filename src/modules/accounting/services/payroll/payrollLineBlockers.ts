/**
 * The approval gate's refusals read off a run's stored lines (payrollApprovalGate step 3), in order:
 * a pre-code line that cannot be judged, a loan payment its payslip does not show as it must, a loan
 * withheld for want of a LOAN deduction, a fringe benefit no 3801 earning carries, a loan instalment
 * above pay, then any other shortfall. The last two loan cases block until the follow-up PR handles
 * them (Hein, 2026-11-02: a loan cap at final pay, and the benefit taxed as non-cash), since approving
 * either would post a GL or PAYE figure that is wrong.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { TxSql } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import { PAYROLL_CALCULATION_VERSION } from './payrollCalculationVersion';
import { findOverdrawnLines, type LoanPaymentOnPayslip, type OverdrawnLine, type WithheldLoanLine } from './payrollRunLines';

export const overdrawnNames = (lines: OverdrawnLine[]) =>
  lines.map((l) => `${l.employeeName ? `${l.employeeName} (${l.employeeNumber})` : l.employeeNumber} (${l.loans?.length ? `loan ${l.loans.join(', ')}, ` : ''}${formatMoney(l.shortfall)} over)`).join(', ');

export function loanInstalmentBlocker(overdrawn: OverdrawnLine[]): PayrollJournalNote | null {
  const blocked = overdrawn.filter((line) => line.fromLoan && !line.unreadable);
  if (blocked.length === 0) return null;
  const legacy = blocked.filter((line) => line.calculationVersion == null
    || line.calculationVersion < PAYROLL_CALCULATION_VERSION);
  if (legacy.length > 0) {
    return {
      code: 'loan_instalment_requires_recalculation',
      detail: `The payslip for ${overdrawnNames(legacy)} was calculated by an earlier version of payroll that may have taken the loan instalment. `
        + 'Recalculate this run before approving, posting, preparing the cash register, or exporting it.',
    };
  }
  return {
    code: 'loan_instalment_exceeds_pay',
    detail: `The payslip is blocked for manual review for ${overdrawnNames(blocked)}. No loan instalment was taken and the loan is unchanged. `
      + 'Adjust or pause the loan, fix the other deductions, then recalculate the run.',
  };
}

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
  const loanBlocker = loanInstalmentBlocker(overdrawn);
  if (loanBlocker) return loanBlocker;
  const blocked = overdrawn.filter((l) => !l.fromLoan);
  if (blocked.length === 0) return null;
  return {
    code: 'deductions_exceed_pay',
    detail: `Deductions and tax exceed pay for ${overdrawnNames(blocked)}: net pay would be nil and the deductions payable understated. `
      + 'Reduce or end those deductions on the employee page, or add to the pay, then recalculate.',
  };
}

/** Shared approval, posting, cash-register and export check. */
export async function payrollLoanInstalmentBlocker(
  companyId: string,
  runId: string,
  db?: TxSql,
): Promise<PayrollJournalNote | null> {
  return loanInstalmentBlocker(await findOverdrawnLines(companyId, runId, db));
}

export class PayrollLineBlockedError extends Error {
  readonly code = 'LOAN_INSTALMENT_EXCEEDS_PAY';
  constructor(detail: string) {
    super(detail);
    this.name = 'PayrollLineBlockedError';
  }
}

export async function assertNoLoanInstalmentBlock(
  companyId: string,
  runId: string,
  db?: TxSql,
): Promise<void> {
  const blocker = await payrollLoanInstalmentBlocker(companyId, runId, db);
  if (blocker) throw new PayrollLineBlockedError(blocker.detail);
}
