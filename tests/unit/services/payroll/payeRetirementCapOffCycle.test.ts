/**
 * Review #1679 codex M2: an off-cycle bonus supplements its month's regular run, so an annual-payment-only off-cycle
 * line adds no s11F cap period (G21 (2027) Rev 1 p. 10: the cap is cap × n ÷ 12 for the periods of the year). March's
 * regular run counts March; the March bonus beside it does not count it again, so the March deduction stays at one
 * month's allowance (R430 000 ÷ 12). A bonus-only REGULAR line (no off-cycle run) still counts its period.
 */
import { describe, expect, it } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const CAP_2027 = 430_000;
const base = { factor: 12, periodsInYear: 12, taxYear: 2027, rebateAge: 40, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0, donations: 0 };
const NONE: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 };

describe('the s11F cap period of an off-cycle bonus (review #1679 M2)', () => {
  // March's regular run: R40 000 salary, R60 000 contributed (far above one month's cap).
  const march = calculateCumulativePaye({ ...base, regularTaxable: 40_000, annualPayments: 0, periodicRemuneration: 40_000,
    annualPaymentRemuneration: 0, retirementContributions: 60_000, ytd: NONE });
  const ytd: PayeYearToDate = { ...NONE, periods: 1, retirementCapPeriods: 1, periodicTaxable: 40_000,
    tablePaye: march.regular.monthlyPaye, retirementContributions: 60_000, retirementDeduction: march.retirementDeduction };
  const bonus = (offCycleLine: boolean) => calculateCumulativePaye({ ...base, regularTaxable: 0, annualPayments: 200_000,
    periodicRemuneration: 0, annualPaymentRemuneration: 200_000, retirementContributions: 0, ytd, offCycleLine });

  it('the March bonus on an off-cycle run adds no cap period: one month\'s allowance in March', () => {
    const line = bonus(true);
    expect(line.trace.capPeriods).toBe(1);
    expect(line.trace.capToDate).toBeCloseTo(CAP_2027 / 12, 6);
    expect(march.retirementDeduction + line.retirementDeduction).toBeLessThanOrEqual(CAP_2027 / 12 + 0.01);
  });

  it('a bonus-only regular line still counts its own period', () => {
    expect(bonus(false).trace.capPeriods).toBe(2);
  });
});
