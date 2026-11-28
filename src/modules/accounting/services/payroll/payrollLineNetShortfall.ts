/**
 * A line's net-pay shortfall results, moved out of payrollCalculator.ts unchanged (wave-7 PRA, refactor(split): file cap).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { ValidationResult } from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function netPayShortfallWarnings(
  { netPay, loanInstalments, allEarnings, grossPay }: { netPay: number; loanInstalments: number; allEarnings: number; grossPay: number },
): ValidationResult[] {
  const warnings: ValidationResult[] = [];
  // The run service previews loan applications through this calculation before writing them. A loan shortfall is
  // therefore a blocking decision and the stored line is rebuilt without the loan. Other deductions keep the
  // historical nil floor and approval refusal.
  if (netPay < 0) {
    const fromLoan = round2(netPay + loanInstalments) >= 0;
    // A non-cash benefit is taxed but not paid: its PAYE comes out of the cash, which may be why.
    const nonCash = round2(allEarnings - grossPay);
    const benefitNote = nonCash > 0 ? ` PAYE includes the tax on ${formatMoney(nonCash)} of non-cash benefits, which are taxed but not paid.` : '';
    warnings.push(fromLoan ? {
      code: 'LOAN_INSTALMENT_EXCEEDS_PAY',
      severity: 'error',
      rawNet: netPay,
      message: `The loan instalment is ${formatMoney(-netPay)} above available pay. This payslip is blocked for manual review.${benefitNote}`,
    } : {
      code: 'DEDUCTIONS_EXCEED_PAY',
      severity: 'error',
      rawNet: netPay,
      message: `Deductions and tax come to ${formatMoney(-netPay)} more than this employee's pay, so net pay shows as nil and `
        + `the deductions payable are understated by that amount.${benefitNote} Reduce the deductions, then recalculate.`,
    });
  }
  return warnings;
}
