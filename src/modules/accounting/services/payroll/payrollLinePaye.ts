/**
 * A line's cumulative PAYE with its donations (4030) allowed. Extracted from payrollCalculator (300-line cap).
 *
 * The donation's 5% is after the retirement deduction, whose own base is before the donation (G21 (2027) p. 10), so
 * PAYE is costed twice: first without the donation for that deduction and the periodic pay it leaves, then with what
 * s18aDonation allows.
 * Donations come off regular pay first, any excess off the annual payments. Only retirement contributions and
 * donations reduce PAYE (para 2(4)); any other taxable deduction is warned (notPayeDeductibleWarning). Pure.
 */
import { calculateCumulativePaye, type CumulativePayeInput } from './payeCumulative';
import { s18aDonationForLine } from './s18aDonation';
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';
import type { PayeYearToDate, ValidationResult } from './payrollTypes';

export function costPayeWithDonations(input: {
  periodicTaxable: number;
  annualPayments: number;
  /** Taxable 4030 deductions (signed). */
  donations: number;
  receiptHeld: boolean;
  payeInput: Omit<CumulativePayeInput, 'regularTaxable' | 'annualPayments' | 'donations'>;
  ytd: PayeYearToDate | undefined;
}) {
  const { periodicTaxable, annualPayments, payeInput } = input;
  const costed = (deductedDonations: number) => {
    const off = deductedDonations;
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
    periodicLeft: periodicTaxable,
    // Earlier lines' periodic taxable is already net of their donations, so this is the room for this line's.
    roomToDate: (input.ytd?.periodicTaxable ?? 0) + before.regularTaxable - before.retirementOffPeriodicToDate,
    retirementDeduction: before.retirementDeduction,
    ytd: input.ytd,
  });
  return { donation, ...costed(donation.deduction) };
}

/**
 * A deduction marked taxable whose code para 2(4) does not allow before PAYE (e.g. 4018, a taxable 4005, 4031): it no
 * longer reduces PAYE, so say so where the payroll officer sees it, with the amount.
 */
export function notPayeDeductibleWarning(name: string, code: string, amount: number): ValidationResult {
  return {
    code: 'DEDUCTION_NOT_PAYE_DEDUCTIBLE',
    severity: 'warning',
    message: `${name} (code ${code}, ${formatMoney(amount)}) is marked taxable, but SARS lets an employer deduct only retirement `
      + 'fund contributions (4001, 4003, 4006) and s18A donations (4030) before PAYE, so PAYE was calculated without it.'
      + (normaliseSarsCode(code) === '4005' ? ' Medical aid contributions give the medical tax credit instead, which was applied.' : ''),
  };
}
