/**
 * PAYE 4c: employee retirement fund contributions (pension 4001, provident
 * 4003, retirement annuity 4006) are deducted from remuneration before PAYE,
 * within section 11F: the lesser of the year's cap and 27.5% of remuneration
 * (SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 5, p. 10-11; Fourth Schedule
 * paragraph 2(4)(a), (b), (bA)). The cap is R430 000 for the 2027 tax year
 * (G21 2027 p. 5, p. 10) and R350 000 before it (PAYE-GEN-01-G20 (2026) p. 5).
 * Annualised like the rest of the cumulative PAYE (payeCumulative.ts):
 * contributions and remuneration to date × 12 ÷ n.
 *
 * Hand figures, 2027 statutory table (G21 2027 p. 3): 18% to 245 100;
 * 44 118 + 26% above 245 100; 125 599 + 36% above 530 200; 185 215 + 39%
 * above 695 800; 666 339 + 45% above 1 878 600; primary rebate 17 820;
 * medical credit R376 a month for the member and first dependant, R254 for
 * each further one (G21 2027 p. 11).
 *
 * Employees A-D are a real employer's March-May 2026 payroll (numbers only),
 * against the figures that employer's Sage payroll deducted.
 */
import { describe, expect, it } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import { allowedRetirementDeduction } from '@/modules/accounting/services/payroll/retirementFund';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 };
const base = { taxYear: 2027, rebateAge: 40, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0 };
const r2 = (n: number) => Math.round(n * 100) / 100;

interface Month { salary: number; contribution: number; bonus?: number; beneficiaries?: number }

/** A year month by month, carrying the year-to-date as the run service and loadPayeYearToDate do. */
function year(months: Month[]) {
  let ytd: PayeYearToDate = NONE;
  return months.map((m) => {
    const r = calculateCumulativePaye({
      ...base, monthlyMedicalBeneficiaries: m.beneficiaries ?? 0,
      regularTaxable: m.salary, annualPayments: m.bonus ?? 0, retirementContributions: m.contribution, ytd,
    });
    const total = r2(r.regular.monthlyPaye + r.annualPaymentPaye);
    ytd = {
      ...ytd,
      periods: ytd.periods + (m.salary > 0 ? 1 : 0), periodicTaxable: ytd.periodicTaxable + m.salary,
      annualPayments: ytd.annualPayments + (m.bonus ?? 0), tablePaye: r2(ytd.tablePaye + total),
      medicalCredit: r2(ytd.medicalCredit + r.medicalCredit),
      retirementContributions: r2((ytd.retirementContributions ?? 0) + m.contribution),
      retirementDeduction: r2((ytd.retirementDeduction ?? 0) + r.retirementDeduction),
    };
    return { ...r, total };
  });
}

describe('s11F: the deduction allowed for a year', () => {
  it('the lesser of the contributions, 27.5% of remuneration and the year\'s cap', () => {
    expect(allowedRetirementDeduction(32_503.08, 720_000, 2027)).toBe(32_503.08); // contributions
    expect(allowedRetirementDeduction(96_000, 240_000, 2027)).toBe(66_000); // 27.5% × 240 000
    expect(allowedRetirementDeduction(600_000, 2_400_000, 2027)).toBe(430_000); // G21 2027: R430 000
    expect(allowedRetirementDeduction(600_000, 2_400_000, 2026)).toBe(350_000); // G20 2026: R350 000
    expect(allowedRetirementDeduction(600_000, 2_400_000, 2025)).toBe(350_000);
    expect(allowedRetirementDeduction(0, 240_000, 2027)).toBe(0);
  });
});

describe('PAYE 4c: the deduction in the cumulative PAYE', () => {
  it('employee A: R60 000, RA R2 708.59, four medical beneficiaries: 12 440.49 (Sage 12 440.51)', () => {
    // RA 32 503.08 a year, under 27.5% × 720 000 = 198 000 and R430 000. Taxable 687 496.92:
    // 125 599 + 36% × 157 296.92 = 182 225.89 − 17 820 − 12 × 1 260 = 149 285.89 ÷ 12 = 12 440.49.
    // Without the deduction (IsaFlow before 4c, no medical) 194 653 − 17 820 = 176 833 ÷ 12 = 14 736.08.
    const months = year(Array(3).fill({ salary: 60_000, contribution: 2_708.59, beneficiaries: 4 }));
    expect(months.map(m => m.total)).toEqual([12_440.49, 12_440.49, 12_440.49]);
    expect(months.map(m => m.retirementDeduction)).toEqual([2_708.59, 2_708.59, 2_708.59]);
    expect(year([{ salary: 60_000, contribution: 0 }])[0]!.total).toBe(14_736.08);
  });

  it('employee B: R55 000, RA R3 796.10, three beneficiaries: 10 502.99 (Sage 10 503.00)', () => {
    // 51 203.90 × 12 = 614 446.80: 125 599 + 36% × 84 246.80 = 155 927.85 − 17 820 − 12 072 = 126 035.85 ÷ 12.
    expect(year([{ salary: 55_000, contribution: 3_796.10, beneficiaries: 3 }])[0]!.total).toBe(10_502.99);
  });

  it('employee D: R15 000, RA R517, no medical aid: 1 121.94 (Sage 1 121.94)', () => {
    // 14 483 × 12 = 173 796 × 18% = 31 283.28 − 17 820 = 13 463.28 ÷ 12.
    expect(year(Array(3).fill({ salary: 15_000, contribution: 517 })).map(m => m.total)).toEqual([1_121.94, 1_121.94, 1_121.94]);
  });

  it('employee C: no RA in April, RA R1 055.83 and four beneficiaries from May: 4 681.00, 1 886.48 (Sage 4 681.01, 1 886.49)', () => {
    // May, n = 2: AE 360 000, RA 1 055.83 × 6 = 6 334.98; taxable 353 665.02: 44 118 + 26% × 108 565.02 = 72 344.91
    // − 17 820 − 15 120 = 39 404.91 × 2/12 = 6 567.48 − 4 681.00 = 1 886.48. Sage's year to date: 6 567.50.
    const months = year([{ salary: 30_000, contribution: 0 }, { salary: 30_000, contribution: 1_055.83, beneficiaries: 4 }]);
    expect(months.map(m => m.total)).toEqual([4_681, 1_886.48]);
    expect(months[1]!.retirementDeduction).toBe(1_055.83);
  });

  it('the 27.5% cap, on remuneration BEFORE the deduction: R20 000 with R8 000 RA deducts 5 500, not 8 000', () => {
    // 27.5% × 240 000 = 66 000: taxable 174 000 × 18% = 31 320 − 17 820 = 13 500 ÷ 12 = 1 125.
    // Uncapped: 144 000 → 675. On the post-deduction base (27.5% × 144 000 = 39 600): 200 400 → 1 521.
    const m = year([{ salary: 20_000, contribution: 8_000 }])[0]!;
    expect([m.total, m.retirementDeduction]).toEqual([1_125, 5_500]);
  });

  it('the R430 000 cap for 2027: R200 000 with R50 000 RA deducts 35 833.33 a month', () => {
    // 600 000 a year; 27.5% × 2 400 000 = 660 000; cap 430 000. Taxable 1 970 000:
    // 666 339 + 45% × 91 400 = 707 469 − 17 820 = 689 649 ÷ 12 = 57 470.75 (at R350 000: 60 470.75).
    const m = year([{ salary: 200_000, contribution: 50_000 }])[0]!;
    expect([m.total, m.retirementDeduction]).toEqual([57_470.75, 35_833.33]);
  });

  it('annualised: a pay rise lifts the 27.5% cap for the year, so the earlier capped months are trued up', () => {
    // Three months R20 000 + R8 000 RA (capped at 5 500): 1 125 each. Month 4 R40 000: n = 4, AE 300 000,
    // RA 96 000 a year, 27.5% × 300 000 = 82 500: taxable 217 500 × 18% = 39 150 − 17 820 = 21 330 × 4/12
    // = 7 110 − 3 375 = 3 735. A month-by-month cap (5 500 × 3 + 8 000) would give 4 275.
    const months = year([...Array(3).fill({ salary: 20_000, contribution: 8_000 }), { salary: 40_000, contribution: 8_000 }]);
    expect(months.map(m => m.total)).toEqual([1_125, 1_125, 1_125, 3_735]);
    // The deduction inside the liability to date is 82 500 × 4/12 = 27 500: this line records 27 500 − 16 500.
    expect(months[3]!.retirementDeduction).toBe(11_000);
  });

  it('an annual payment is remuneration: it widens the 27.5% base (G21 2027 p. 10: remuneration as the Fourth Schedule defines it)', () => {
    // R20 000 + R8 000 RA + R40 000 bonus: base 280 000 × 27.5% = 77 000; AE 240 000 − 77 000 = 163 000.
    // tax(163 000) = 29 340 − 17 820 = 11 520 ÷ 12 = 960; bonus: tax(203 000) − tax(163 000) = 7 200.
    const m = year([{ salary: 20_000, contribution: 8_000, bonus: 40_000 }])[0]!;
    expect([m.regular.monthlyPaye, m.annualPaymentPaye]).toEqual([960, 7_200]);
  });

  it('a deduction larger than the annual equivalent comes off the annual payments, never below nil', () => {
    // R5 000 + R20 000 RA + R300 000 bonus: base 360 000 × 27.5% = 99 000; AE 60 000, so 39 000 comes off
    // the bonus: tax(261 000) = 44 118 + 26% × 15 900 = 48 252 − 17 820 = 30 432. Recorded 60 000 ÷ 12 + 39 000.
    const m = year([{ salary: 5_000, contribution: 20_000, bonus: 300_000 }])[0]!;
    expect([m.regular.monthlyPaye, m.annualPaymentPaye, m.retirementDeduction]).toEqual([0, 30_432, 44_000]);
  });

  it('no contributions changes nothing (the 4a figures stand)', () => {
    const months = year(Array(12).fill({ salary: 20_000, contribution: 0 }));
    expect(months.map(m => m.total)).toEqual(Array(12).fill(2_115));
    expect(months.every(m => m.retirementDeduction === 0)).toBe(true);
  });
});
