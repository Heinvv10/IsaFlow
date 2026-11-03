/**
 * PAYE 4c: focused cumulative s11F examples for salary, annual-payment and
 * signed-correction periods. Figures use the 2027 table and R430 000 cap from
 * SARS PAYE-GEN-01-G21 (2027) p. 3, p. 5 and p. 10-11.
 */
import { describe, expect, it } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = {
  periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0,
  medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const CAP_2027 = 430_000;

interface Month { salary: number; contribution: number; bonus?: number; donation?: number }

/** A tax year carried forward in the same shape as loadPayeYearToDate. */
function year(months: Month[]) {
  let ytd: PayeYearToDate = NONE;
  return months.map((month) => {
    const result = calculateCumulativePaye({
      taxYear: 2027, rebateAge: 40, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0,
      regularTaxable: month.salary - (month.donation ?? 0), annualPayments: month.bonus ?? 0,
      retirementContributions: month.contribution, donations: month.donation ?? 0, ytd,
    });
    const totalPaye = r2(result.regular.monthlyPaye + result.annualPaymentPaye);
    const capPeriods = (ytd.retirementCapPeriods ?? ytd.periods)
      + (month.salary > 0 || (month.bonus ?? 0) > 0 ? 1 : 0);
    ytd = {
      ...ytd,
      periods: ytd.periods + (month.salary > 0 ? 1 : 0),
      retirementCapPeriods: capPeriods,
      periodicTaxable: ytd.periodicTaxable + month.salary - (month.donation ?? 0),
      annualPayments: ytd.annualPayments + (month.bonus ?? 0),
      tablePaye: r2(ytd.tablePaye + totalPaye),
      retirementContributions: r2((ytd.retirementContributions ?? 0) + month.contribution),
      retirementDeduction: r2((ytd.retirementDeduction ?? 0) + result.retirementDeduction),
      donations: r2((ytd.donations ?? 0) + (month.donation ?? 0)),
    };
    return {
      ...result,
      totalPaye,
      capPeriods,
      contributedToDate: ytd.retirementContributions,
      deductedToDate: ytd.retirementDeduction,
    };
  });
}

function expectLimits(months: ReturnType<typeof year>) {
  for (const month of months) {
    expect(month.deductedToDate).toBeLessThanOrEqual(month.contributedToDate! + 0.01);
    expect(month.deductedToDate).toBeLessThanOrEqual((CAP_2027 * Math.max(month.capPeriods, 1)) / 12 + 0.01);
  }
}

describe('PAYE 4c: salary, bonus-only periods and signed corrections', () => {
  it('allows the normal salary-month deduction within contributions and the 27.5% limit', () => {
    // C = 8 000 x 12 = 96 000; 27.5% x 240 000 = 66 000, so D = 66 000.
    // To date: 66 000 / 12 = 5 500. Tax: (174 000 x 18% - 17 820) / 12 = 1 125.
    const months = year([{ salary: 20_000, contribution: 8_000 }]);
    expect([months[0]!.retirementDeduction, months[0]!.totalPaye]).toEqual([5_500, 1_125]);
    expectLimits(months);
  });

  it('limits a bonus-only period after salary months to the accumulated period cap', () => {
    // Six salary months leave D-to-date = 33 000 x 6/12 = 16 500. In the bonus-only period,
    // D = min(1 100 000 x 12/6, 27.5% x 2 120 000, 430 000) = 430 000.
    // 60 000 comes off periodic pay and 190 833.33 off the bonus: 250 833.33 = 430 000 x 7/12.
    // Tax is tax(2 000 000 - 190 833.33) = 620 051.33; prior salary-month PAYE was nil.
    const months = year([
      ...Array(6).fill({ salary: 10_000, contribution: 100_000 }),
      { salary: 0, contribution: 500_000, bonus: 2_000_000 },
    ]);
    expect([
      months[6]!.retirementDeduction,
      months[6]!.deductedToDate,
      months[6]!.totalPaye,
    ]).toEqual([234_333.33, 250_833.33, 620_051.33]);
    expectLimits(months);
  });

  it('uses salary and bonus together in the 27.5% base without over-deducting', () => {
    // C = 8 000 x 12 = 96 000; 27.5% x (240 000 + 40 000) = D 77 000.
    // D-to-date = 77 000/12 = 6 416.67. PAYE: 960 on AE 163 000 plus 7 200 on the bonus.
    const months = year([{ salary: 20_000, contribution: 8_000, bonus: 40_000 }]);
    expect([
      months[0]!.retirementDeduction,
      months[0]!.regular.monthlyPaye,
      months[0]!.annualPaymentPaye,
    ]).toEqual([6_416.67, 960, 7_200]);
    expectLimits(months);
  });

  it('advances the cap once for each repeated bonus-only period', () => {
    // After the first bonus-only period D-to-date is 430 000 x 7/12 = 250 833.33.
    // The second raises the limit to 430 000 x 8/12 = 286 666.67, so its line records 35 833.34.
    const months = year([
      ...Array(6).fill({ salary: 10_000, contribution: 100_000 }),
      { salary: 0, contribution: 500_000, bonus: 2_000_000 },
      { salary: 0, contribution: 500_000, bonus: 2_000_000 },
    ]);
    expect([months[7]!.retirementDeduction, months[7]!.deductedToDate]).toEqual([35_833.34, 286_666.67]);
    expectLimits(months);
  });

  it('nets a negative correction before clamping, reversing the earlier deduction and raising PAYE', () => {
    // Month 1: D-to-date = 5 500 and PAYE = 1 125. Month 2 correction nets contributions to zero,
    // so D-to-date falls to zero and the line records -5 500. Undeducted tax to date is
    // (240 000 x 18% - 17 820) x 2/12 = 4 230; current PAYE = 4 230 - 1 125 = 3 105.
    const months = year([
      { salary: 20_000, contribution: 8_000 },
      { salary: 20_000, contribution: -8_000 },
    ]);
    expect([
      months[1]!.contributedToDate,
      months[1]!.retirementDeduction,
      months[1]!.deductedToDate,
      months[1]!.totalPaye,
    ]).toEqual([0, -5_500, 0, 3_105]);
    expect(months[1]!.totalPaye).toBeGreaterThan(months[0]!.totalPaye);
    expectLimits(months);
  });

  it('records the retirement deduction reversal in a correction-only no-pay period', () => {
    // Month 1 records D-to-date = 5 500. The no-pay correction nets contributions to zero,
    // so the line reverses that deduction without advancing the pay or cap periods.
    const months = year([
      { salary: 20_000, contribution: 8_000 },
      { salary: 0, contribution: -8_000 },
    ]);
    expect([
      months[1]!.periods,
      months[1]!.capPeriods,
      months[1]!.contributedToDate,
      months[1]!.retirementDeduction,
      months[1]!.deductedToDate,
      months[1]!.totalPaye,
    ]).toEqual([1, 1, 0, -5_500, 0, 0]);
    expectLimits(months);
  });

  it('does not grow the retirement deduction in a contribution-only no-pay period', () => {
    const months = year([{ salary: 0, contribution: 8_000 }]);
    expect([
      months[0]!.periods,
      months[0]!.capPeriods,
      months[0]!.retirementDeduction,
      months[0]!.deductedToDate,
      months[0]!.totalPaye,
    ]).toEqual([0, 0, 0, 0, 0]);
    expectLimits(months);
  });

  it('also nets signed donation corrections before using donations in the 27.5% base', () => {
    // Month 1 adds the R1 000 donation back: D-to-date = 27.5% x 240 000 / 12 = 5 500.
    // Month 2 reverses it, so cumulative donations are zero and D-to-date = 27.5% x 240 000 x 2/12 = 11 000.
    // Tax to date is (174 000 x 18% - 17 820) x 2/12 = 2 250; current PAYE = 2 250 - 945 = 1 305.
    const months = year([
      { salary: 20_000, contribution: 8_000, donation: 1_000 },
      { salary: 20_000, contribution: 8_000, donation: -1_000 },
    ]);
    expect([months[1]!.retirementDeduction, months[1]!.deductedToDate, months[1]!.totalPaye]).toEqual([
      5_500, 11_000, 1_305,
    ]);
    expectLimits(months);
  });
});
