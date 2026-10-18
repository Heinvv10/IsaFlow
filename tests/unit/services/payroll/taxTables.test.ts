import { describe, it, expect } from 'vitest';
import {
  getTaxYear,
  getTaxYearConfig,
  computeAnnualTax,
  UnsupportedTaxYearError,
} from '@/modules/accounting/services/payroll/taxTables';
import { calculatePAYE } from '@/modules/accounting/services/payroll/payeEngine';

/**
 * Expected values are computed here by hand from the SARS published rates:
 * tax = base + rate x (income - threshold), where `threshold` is the TOP of the
 * previous bracket. Nothing below calls the code under test to build an
 * expected number.
 *
 * 2026/27 (taxYear 2027), https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/
 */
describe('2026/27 brackets (taxYear 2027), hand-computed', () => {
  const brackets = getTaxYearConfig(2027).brackets;

  it.each([
    // income, expected
    [0, 0],
    [100_000, 18_000],                        // 18% x 100 000
    [245_100, 44_118],                        // top of bracket 1: 18% x 245 100
    [245_101, 44_118.26],                     // 44 118 + 26% x 1
    [300_000, 58_392],                        // 44 118 + 26% x 54 900
    [383_100, 79_998],                        // 44 118 + 26% x 138 000
    [383_101, 79_998.31],                     // 79 998 + 31% x 1
    [480_000, 110_037],                       // 79 998 + 31% x 96 900
    [530_200, 125_599],                       // 79 998 + 31% x 147 100
    [530_201, 125_599.36],
    [600_000, 150_727],                       // 125 599 + 36% x 69 800
    [695_800, 185_215],                       // 125 599 + 36% x 165 600
    [695_801, 185_215.39],
    [887_000, 259_783],                       // 185 215 + 39% x 191 200
    [887_001, 259_783.41],
    [1_000_000, 306_113],                     // 259 783 + 41% x 113 000
    [1_878_600, 666_339],                     // 259 783 + 41% x 991 600
    [1_878_601, 666_339.45],
    [2_000_000, 720_969],                     // 666 339 + 45% x 121 400
  ])('annual tax on %d is %d', (income, expected) => {
    expect(computeAnnualTax(income, brackets)).toBeCloseTo(expected, 2);
  });
});

describe('2025/26 brackets (taxYear 2026) are unchanged', () => {
  const brackets = getTaxYearConfig(2026).brackets;

  it.each([
    [237_100, 42_678],      // 18% x 237 100
    [237_101, 42_678.26],
    [370_500, 77_362],      // 42 678 + 26% x 133 400
    [480_000, 111_307],     // 77 362 + 31% x 109 500
    [512_800, 121_475],     // 77 362 + 31% x 142 300
    [673_000, 179_147],     // 121 475 + 36% x 160 200
    [857_900, 251_258],     // 179 147 + 39% x 184 900
    [1_817_000, 644_489],   // 251 258 + 41% x 959 100
    [2_000_000, 726_839],   // 644 489 + 45% x 183 000
  ])('annual tax on %d is %d', (income, expected) => {
    expect(computeAnnualTax(income, brackets)).toBeCloseTo(expected, 2);
  });
});

describe('K-260: the first bracket carries no +R1 error', () => {
  it('tax on R100 000 is exactly R18 000, not R18 000.18', () => {
    expect(computeAnnualTax(100_000, getTaxYearConfig(2027).brackets)).toBe(18_000);
    expect(computeAnnualTax(100_000, getTaxYearConfig(2026).brackets)).toBe(18_000);
  });
});

describe('getTaxYearConfig', () => {
  it('holds the 2026/27 rebates, thresholds and medical credits', () => {
    const c = getTaxYearConfig(2027);
    expect([c.primaryRebate, c.secondaryRebate, c.tertiaryRebate]).toEqual([17_820, 9_765, 3_249]);
    expect([c.thresholdBelow65, c.threshold65to74, c.threshold75plus]).toEqual([99_000, 153_250, 171_300]);
    expect([c.medicalCreditMainAndFirst, c.medicalCreditAdditional]).toEqual([376, 254]);
  });

  it('keeps the 2025/26 rebates and credits', () => {
    const c = getTaxYearConfig(2026);
    expect([c.primaryRebate, c.secondaryRebate, c.tertiaryRebate]).toEqual([17_235, 9_444, 3_145]);
    expect([c.medicalCreditMainAndFirst, c.medicalCreditAdditional]).toEqual([364, 246]);
  });

  it('throws for an unregistered year instead of using the latest one', () => {
    expect(() => getTaxYearConfig(2028)).toThrow(UnsupportedTaxYearError);
    expect(() => getTaxYearConfig(2028)).toThrow(/tax year 2028/);
    expect(() => getTaxYearConfig(2024)).toThrow(UnsupportedTaxYearError);
  });

  it('maps March 2026 - February 2027 to tax year 2027', () => {
    expect(getTaxYear(3, 2026)).toBe(2027);
    expect(getTaxYear(2, 2027)).toBe(2027);
    expect(getTaxYear(3, 2027)).toBe(2028);
  });
});

describe('monthly PAYE per age band, 2026/27 (taxYear 2027), hand-computed', () => {
  const paye = (annual: number, age: number, medical = 0) =>
    calculatePAYE({
      annualTaxableIncome: annual,
      ageAtPeriodEnd: age,
      monthlyMedicalBeneficiaries: medical,
      taxYear: 2027,
    });

  it('under 65, R480 000: (110 037 - 17 820) / 12', () => {
    expect(paye(480_000, 40).monthlyPaye).toBe(7_684.75);
  });

  it('65-74, R480 000: (110 037 - 27 585) / 12', () => {
    expect(paye(480_000, 65).monthlyPaye).toBe(6_871);
    expect(paye(480_000, 74).monthlyPaye).toBe(6_871);
  });

  it('75+, R480 000: (110 037 - 30 834) / 12', () => {
    expect(paye(480_000, 75).monthlyPaye).toBe(6_600.25);
  });

  it('under 65 with main member and one dependant: credits 2 x 376 x 12', () => {
    expect(paye(480_000, 40, 2).monthlyPaye).toBe(6_932.75);   // (92 217 - 9 024) / 12
  });

  it('under 65 with main member, one dependant and one more: (376 + 376 + 254) x 12', () => {
    expect(paye(480_000, 40, 3).monthlyPaye).toBe(6_678.75);   // (92 217 - 12 072) / 12
  });

  it('65+ on R200 000: (36 000 - 27 585) / 12', () => {
    expect(paye(200_000, 66).monthlyPaye).toBe(701.25);
  });

  it('top bracket, under 65, R2 400 000: (900 969 - 17 820) / 12', () => {
    expect(paye(2_400_000, 40).monthlyPaye).toBe(73_595.75);
  });

  it('pays nothing at each age threshold', () => {
    expect(paye(99_000, 40).monthlyPaye).toBe(0);     // 17 820 - 17 820
    expect(paye(153_250, 66).monthlyPaye).toBe(0);    // 27 585 - 27 585
    expect(paye(171_300, 80).monthlyPaye).toBe(0);    // 30 834 - 30 834
  });
});

describe('monthly PAYE, 2025/26 (taxYear 2026), hand-computed', () => {
  const paye = (annual: number, age: number) =>
    calculatePAYE({
      annualTaxableIncome: annual,
      ageAtPeriodEnd: age,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2026,
    });

  it('under 65, R480 000: (111 307 - 17 235) / 12', () => {
    expect(paye(480_000, 40).monthlyPaye).toBe(7_839.33);
  });
  it('65-74: rebates 17 235 + 9 444', () => {
    expect(paye(480_000, 65).monthlyPaye).toBe(7_052.33);
  });
  it('75+: rebates 17 235 + 9 444 + 3 145', () => {
    expect(paye(480_000, 75).monthlyPaye).toBe(6_790.25);
  });
});
