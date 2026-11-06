/**
 * A line's cumulative PAYE with its donations (4030) allowed. Extracted from payrollCalculator (300-line cap).
 *
 * The donation's 5% is after the retirement deduction, whose own base is before the donation (G21 (2027) p. 10), so
 * PAYE is costed twice: first without the donation for that deduction and the periodic pay it leaves, then with what
 * s18aDonation allows.
 * Taxable deductions come off regular pay first, any excess off the annual payments. Pure.
 */
import { calculateCumulativePaye, type CumulativePayeInput } from './payeCumulative';
import { s18aDonationForLine } from './s18aDonation';
import type { PayeYearToDate } from './payrollTypes';

export function costPayeWithDonations(input: {
  periodicTaxable: number;
  annualPayments: number;
  /** Taxable deductions other than retirement contributions and donations. */
  taxableDeductions: number;
  /** Taxable 4030 deductions (signed). */
  donations: number;
  receiptHeld: boolean;
  payeInput: Omit<CumulativePayeInput, 'regularTaxable' | 'annualPayments' | 'donations'>;
  ytd: PayeYearToDate | undefined;
}) {
  const { periodicTaxable, annualPayments, taxableDeductions, payeInput } = input;
  const costed = (deductedDonations: number) => {
    const off = taxableDeductions + deductedDonations;
    const regularTaxable = Math.max(0, periodicTaxable - off);
    const annualTaxable = Math.max(0, annualPayments - Math.max(0, off - periodicTaxable));
    return {
      regularTaxable,
      annualTaxable,
      ...calculateCumulativePaye({ ...payeInput, regularTaxable, annualPayments: annualTaxable, donations: deductedDonations }),
    };
  };
  const before = costed(0);
  const donation = s18aDonationForLine({
    receiptHeld: input.receiptHeld,
    donations: input.donations,
    remuneration: periodicTaxable + annualPayments,
    periodicLeft: periodicTaxable - taxableDeductions,
    // Earlier lines' periodic taxable is already net of their donations, so this is the room for this line's.
    roomToDate: (input.ytd?.periodicTaxable ?? 0) + before.regularTaxable - before.retirementOffPeriodicToDate,
    retirementDeduction: before.retirementDeduction,
    ytd: input.ytd,
  });
  return { donation, ...costed(donation.deduction) };
}
