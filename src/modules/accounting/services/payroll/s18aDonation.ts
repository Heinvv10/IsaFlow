/**
 * The deduction a line allows for donations (4030), cumulative over the tax year.
 *
 * SARS PAYE-GEN-01-G21 (2027) Rev 1 "Donations" (Fourth Schedule para 2(4)(f); s18A(2)(a)): at most 5% of
 * remuneration after pension, provident and retirement annuity fund contributions, and only if the employee has
 * given the employer a receipt. The full donation still leaves net pay and stays on the line's breakdown.
 *
 *   base to date    = taxable remuneration to date (a bonus clawback lowers it) - retirement deduction to date
 *   allowed to date = min(receipted to date, 5% of base to date)
 *   this line       = allowed to date - allowed on earlier lines, at most the periodic pay left on this line and,
 *                     to date, after the retirement deduction that comes off periodic pay
 *
 * A donation comes off that periodic pay only: the rest waits for a later line, and at year end for the assessment.
 * So the add-back to the s11F base (payeCumulative, which annualises it) is right, the retirement deduction is the
 * same with or without the donation, and a line with no pay moves neither PAYE nor SDL. A reversal counts with or without a receipt, but only against what counted earlier: a
 * donation that never reduced anything has nothing to take back. With the receipt tick cleared nothing further is
 * allowed; what earlier lines allowed stands (a tick is the employer's record, not a retraction).
 *
 * Lines from before migration 959 are in none of the sums, so the rule starts with the next run: no credit and no
 * clawback (Hein: as for SDL). Reversing such a line's donation still undoes its PAYE deduction, but not SDL, which
 * it never reduced (sdlDeduction). Pure.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import type { PayeYearToDate, ValidationResult } from './payrollTypes';

export const DONATION_LIMIT = 0.05;
const round2 = (n: number): number => Math.round(n * 100) / 100 + 0; // + 0: never -0

export interface S18aDonationResult {
  /** 4030 on this line counted toward the limit (signed). */
  receipted: number;
  /** This line's remuneration less its retirement deduction. */
  base: number;
  /** The deduction this line allows (signed): off PAYE. */
  deduction: number;
  /** Its part that moves SDL: the rise in the liable lines' donations, kept above nil (a pre-959 line never reduced SDL). */
  sdlDeduction: number;
  warnings: ValidationResult[];
}

export function s18aDonationForLine(input: {
  receiptHeld: boolean;
  /** This line's taxable 4030 deductions (signed). */
  donations: number;
  /** This line's taxable remuneration before any deduction, net of a bonus clawback (signed). */
  remuneration: number;
  /** The periodic taxable pay left on this line after its other taxable deductions (signed: a clawback can pass it). */
  periodicLeft: number;
  /** The periodic pay to date left for donations on this line, after earlier donations and the retirement deduction. */
  roomToDate: number;
  /** The retirement deduction recorded on this line (signed). */
  retirementDeduction: number;
  ytd: PayeYearToDate | undefined;
}): S18aDonationResult {
  const { receiptHeld, donations, ytd } = input;
  const earlierReceipted = ytd?.donationReceipted ?? 0;
  const earlierAllowed = ytd?.donationDeduction ?? 0;
  // A reversal takes back only what counted: receipted lines, and the donations of lines from before migration 959.
  const reversible = earlierReceipted + Math.max(0, (ytd?.donations ?? 0) - earlierAllowed);
  const receipted = round2(donations < 0 ? Math.max(donations, -reversible) : receiptHeld ? donations : 0);
  const base = round2(input.remuneration - input.retirementDeduction);
  const receiptedToDate = round2(earlierReceipted + receipted);
  const limitToDate = round2(DONATION_LIMIT * Math.max(0, (ytd?.donationBase ?? 0) + base));
  const allowedToDate = Math.min(receiptedToDate, receiptHeld ? limitToDate : earlierAllowed);
  const wanted = Math.min(allowedToDate - earlierAllowed, Math.max(0, input.periodicLeft), Math.max(0, input.roomToDate));
  // Under a clawback past the periodic pay the nil floor would swallow a take-back: it waits for a line that can bear it.
  const deduction = round2(input.periodicLeft < 0 ? Math.max(0, wanted) : wanted);
  const earlierSdl = ytd?.sdlDonationDeduction ?? 0;
  const sdlDeduction = round2(Math.max(0, earlierSdl + deduction) - earlierSdl);

  const warnings: ValidationResult[] = [];
  if (donations > 0 && !receiptHeld) {
    warnings.push({
      code: 'DONATION_WITHOUT_S18A_RECEIPT',
      severity: 'warning',
      message: `${formatMoney(donations)} of donations (code 4030) is deducted from pay with no s18A receipt on record, so it does not `
        + 'reduce PAYE or SDL. Once the employer holds the receipt, tick it on the employee and recalculate.',
    });
  }
  if (donations > 0 && receiptHeld && receiptedToDate > limitToDate) {
    warnings.push({
      code: 'DONATION_ABOVE_S18A_LIMIT',
      severity: 'warning',
      message: `Donations to date of ${formatMoney(receiptedToDate)} are above the limit of ${formatMoney(limitToDate)} (5% of remuneration `
        + 'after retirement fund contributions). Only the limit reduces PAYE and SDL; the rest may be claimed on assessment.',
    });
  }
  return { receipted, base, deduction, sdlDeduction, warnings };
}
