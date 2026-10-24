/**
 * PAYE 4a follow-ups G4: cumulative (run-to-date) PAYE, Hein 2026-10-22.
 * Method and sources: src/modules/accounting/services/payroll/payeCumulative.ts
 * (SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 8 "Annual equivalent calculation" and
 * p. 32-33 "Annual payments/bonus"; PAYE-GEN-01-G01 Rev 16 p. 5).
 *
 * Expected figures are computed independently from the 2027 statutory table
 * (G21 p. 3: 18% to 245 100; 44 118 + 26% above 245 100; 79 998 + 31% above
 * 383 100; primary rebate 17 820), employee under 65, no medical aid:
 *   tax(240 000) = 25 380   tax(360 000) = 56 172   tax(300 000) = 40 572
 *   tax(320 000) = 45 772   tax(336 000) = 49 932   tax(350 800) = 53 780
 */
import { describe, it, expect } from 'vitest';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import { annualTaxAfterCredits, calculatePAYE } from '@/modules/accounting/services/payroll/payeEngine';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 };
const base = { taxYear: 2027, rebateAge: 46, monthlyMedicalBeneficiaries: 0, medicalSchemeFees: 0 };

/** Runs a year month by month, carrying the year-to-date as the run service does. */
function year(salaries: number[], bonuses: number[] = salaries.map(() => 0)) {
  let ytd = NONE;
  return salaries.map((s, i) => {
    const r = calculateCumulativePaye({ ...base, regularTaxable: s, annualPayments: bonuses[i]!, ytd });
    const total = Math.round((r.regular.monthlyPaye + r.annualPaymentPaye) * 100) / 100;
    ytd = {
      periods: ytd.periods + (s > 0 ? 1 : 0), periodicTaxable: ytd.periodicTaxable + s,
      annualPayments: ytd.annualPayments + bonuses[i]!, tablePaye: ytd.tablePaye + total, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
    };
    return { regular: r.regular.monthlyPaye, annual: r.annualPaymentPaye, total };
  });
}

describe('cumulative PAYE', () => {
  it('the first period equals the x12 method, for salary alone and with a bonus (#752: 4 161 + 3 848)', () => {
    for (const [salary, bonus] of [[20_000, 0], [28_000, 14_800], [5_000, 0], [95_000, 30_000]] as const) {
      // The x12 method (#752): tables on salary × 12; the bonus as tax(AE + bonus) − tax(AE).
      const p = { ageAtPeriodEnd: base.rebateAge, monthlyMedicalBeneficiaries: 0, taxYear: 2027 };
      const tax = (x: number) => annualTaxAfterCredits({ ...p, annualTaxableIncome: x }).annualTax;
      const x12 = [calculatePAYE({ ...p, annualTaxableIncome: salary * 12 }).monthlyPaye, Math.round((tax(salary * 12 + bonus) - tax(salary * 12)) * 100) / 100];
      const now = calculateCumulativePaye({ ...base, regularTaxable: salary, annualPayments: bonus, ytd: NONE });
      expect([now.regular.monthlyPaye, now.annualPaymentPaye], `${salary}/${bonus}`).toEqual(x12);
    }
    const m1 = calculateCumulativePaye({ ...base, regularTaxable: 28_000, annualPayments: 14_800, ytd: NONE });
    expect([m1.regular.monthlyPaye, m1.annualPaymentPaye]).toEqual([4_161, 3_848]);
  });

  it('SARS\'s worked examples, by the statutory table: the gap to the printed figures is SARS\'s banded tables, not the method', () => {
    const p = { ageAtPeriodEnd: base.rebateAge, monthlyMedicalBeneficiaries: 0, taxYear: 2027 };
    const tax = (x: number) => annualTaxAfterCredits({ ...p, annualTaxableIncome: x }).annualTax;
    // G21 p. 8: R110 000 over 7 months, AE 188 571; SARS prints tax R16 156 and 16 156 ÷ 12 × 7 = R9 424.33.
    // The statutory table gives tax(188 571.43) = 16 122.86 and, over the 7 months, 9 405.00 in total.
    expect(Math.round(tax(110_000 * 12 / 7) * 100) / 100).toBe(16_122.86);
    expect(year([...Array(6).fill(15_000), 20_000]).reduce((t, m) => t + m.total, 0)).toBe(9_405);
    // G21 p. 33: salary R28 000 + bonus R14 800; SARS prints tax(336 000) 49 945, tax(350 800) 53 723 (bonus
    // 3 778, salary 4 171 a month). The statutory table gives 49 932 and 53 780: 4 161 + 3 848.
    expect([tax(336_000), tax(350_800)]).toEqual([49_932, 53_780]);
    // The printed figures are SARS's annual deduction tables (PAYE-GEN-01-G01-A04 2027): R500 bands taxed at
    // their midpoint. R335 801–336 301 → 49 945, R350 330–350 830 → 53 723, R188 507–189 007 → 16 156.
    expect([tax(336_051), tax(350_580), tax(188_757)].map(Math.round)).toEqual([49_945, 53_723, 16_156]);
  });

  it('a flat salary all year equals x12 every month', () => {
    expect(year(Array(12).fill(20_000)).map(m => m.total)).toEqual(Array(12).fill(2_115));
  });

  it('a salary increase in month 7 is spread; a month-12 bonus is taxed on the annual equivalent; the year sums to the annual liability', () => {
    const months = year([...Array(6).fill(20_000), ...Array(6).fill(30_000)], [...Array(11).fill(0), 20_000]);
    // Sep: AE = 150 000 × 12 / 7 = 257 142.86, tax 29 429.14 × 7/12 = 17 167 − 6 × 2 115 = 4 477 (x12: 4 681).
    expect(months.map(m => m.total)).toEqual([2115, 2115, 2115, 2115, 2115, 2115, 4477, 4681, 4681, 4681, 4681, 9881]);
    expect(months[11]).toEqual({ regular: 4681, annual: 5200, total: 9881 });
    // tax(300 000 + 20 000) = 45 772: the year deducts exactly the liability (x12 deducts 45 976).
    expect(months.reduce((t, m) => t + m.total, 0)).toBe(45_772);
  });

  it('an earlier annual payment stays in the base: a second bonus is taxed on top of the first', () => {
    const bonuses = [0, 0, 10_000, 0, 0, 0, 0, 0, 0, 20_000, 0, 0];
    const months = year(Array(12).fill(20_000), bonuses);
    expect(months[2]!.annual).toBe(2_192); // tax(250 000) − tax(240 000)
    // tax(270 000) − tax(250 000) = 32 772 − 27 572; on its own it would be tax(260 000) − tax(240 000) = 4 792.
    expect(months[9]!.annual).toBe(5_200);
  });

  it('an over-deduction is floored at nil and carried, not refunded', () => {
    const months = year([...Array(3).fill(40_000), ...Array(9).fill(5_000)]);
    expect(months.map(m => m.total)).toEqual([7684.75, 7684.75, 7684.75, ...Array(9).fill(0)]);
  });

  it('the final month of a short tax period settles G21 p. 8\'s liability: tax(AE) × 7 / 12', () => {
    // R15 000 × 6 + R25 000: AE = 115 000 × 12 / 7 = 197 142.86, tax 17 665.71 × 7/12 = 10 305 − 6 × 1 215.
    const months = year([...Array(6).fill(15_000), 25_000]);
    expect(months[6]!.total).toBe(3_015);
    expect(months.reduce((t, m) => t + m.total, 0)).toBe(10_305);
  });

  it('a period with no periodic pay and no annual payment deducts nothing from the tables', () => {
    const r = calculateCumulativePaye({ ...base, regularTaxable: 0, annualPayments: 0, ytd: { periods: 2, periodicTaxable: 40_000, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 } });
    expect([r.regular.monthlyPaye, r.annualPaymentPaye]).toEqual([0, 0]);
  });

  it('a bonus-only period does not count as a period worked: the annual equivalent stays on the periods with pay', () => {
    // n = 2, AE = 240 000: 25 380 × 2/12 + (tax(260 000) − tax(240 000)) − 4 230 = 4 792, all of it the bonus's.
    const r = calculateCumulativePaye({ ...base, regularTaxable: 0, annualPayments: 20_000, ytd: { periods: 2, periodicTaxable: 40_000, annualPayments: 0, tablePaye: 4_230, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 } });
    expect([r.regular.monthlyPaye, r.annualPaymentPaye, r.periods]).toEqual([0, 4_792, 2]);
  });

  it('a bonus with no periodic pay this year: the whole bonus on a nil annual equivalent (#752: 3 780)', () => {
    const r = calculateCumulativePaye({ ...base, regularTaxable: 0, annualPayments: 120_000, ytd: NONE });
    expect([r.regular.monthlyPaye, r.annualPaymentPaye]).toEqual([0, 3_780]);
  });
});
