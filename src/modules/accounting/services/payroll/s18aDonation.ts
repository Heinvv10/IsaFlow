/**
 * The deduction a line allows for donations (4030), cumulative over the tax year.
 *
 * SARS PAYE-GEN-01-G21 (2027) Rev 1 "Donations" (Fourth Schedule para 2(4)(f); s18A(2)(a)): at most 5% of
 * remuneration after pension, provident and retirement annuity fund contributions, and only if the employee has
 * given the employer a receipt. The full donation still leaves net pay and stays on the certificate under 4030.
 *
 *   base to date    = remuneration to date - retirement deduction to date
 *   allowed to date = min(receipted to date, 5% of base to date)
 *   this line       = allowed to date - allowed on earlier lines
 *
 * A reversal always counts, receipt or not. Lines from before migration 959 are in none of the sums, so the rule
 * starts with the next run: no credit and no clawback (Hein: as for SDL). Reversals that take the receipted
 * figure below nil undo such a line's donation, and that negative stands. Pure.
 */
import type { PayeYearToDate, ValidationResult } from './payrollTypes';

const DONATION_LIMIT = 0.05;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface S18aDonationResult {
  /** 4030 on this line counted toward the limit (signed). */
  receipted: number;
  /** This line's remuneration less its retirement deduction. */
  base: number;
  /** The deduction this line allows (signed): off PAYE and SDL. */
  deduction: number;
  warnings: ValidationResult[];
}

export function s18aDonationForLine(input: {
  receiptHeld: boolean;
  /** This line's taxable 4030 deductions (signed). */
  donations: number;
  /** This line's remuneration before any deduction. */
  remuneration: number;
  /** The retirement deduction recorded on this line (signed). */
  retirementDeduction: number;
  ytd: PayeYearToDate | undefined;
}): S18aDonationResult {
  const { receiptHeld, donations, ytd } = input;
  const receipted = round2(receiptHeld || donations < 0 ? donations : 0);
  const base = round2(input.remuneration - input.retirementDeduction);
  const receiptedToDate = round2((ytd?.donationReceipted ?? 0) + receipted);
  const limitToDate = round2(DONATION_LIMIT * Math.max(0, (ytd?.donationBase ?? 0) + base));
  const allowedToDate = Math.min(receiptedToDate, limitToDate);
  const deduction = round2(allowedToDate - (ytd?.donationDeduction ?? 0));

  const warnings: ValidationResult[] = [];
  if (donations > 0 && !receiptHeld) {
    warnings.push({
      code: 'DONATION_WITHOUT_S18A_RECEIPT',
      severity: 'warning',
      message: `R${donations.toFixed(2)} of donations (code 4030) is deducted from pay with no s18A receipt on record, so it does not `
        + 'reduce PAYE or SDL. Once the employer holds the receipt, tick it on the employee and recalculate.',
    });
  }
  if (donations > 0 && receiptHeld && receiptedToDate > limitToDate) {
    warnings.push({
      code: 'DONATION_ABOVE_S18A_LIMIT',
      severity: 'warning',
      message: `Donations to date of R${receiptedToDate.toFixed(2)} are above the limit of R${limitToDate.toFixed(2)} (5% of remuneration `
        + 'after retirement fund contributions). Only the limit reduces PAYE and SDL; the rest may be claimed on assessment.',
    });
  }
  return { receipted, base, deduction, warnings };
}
