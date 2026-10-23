/**
 * PAYE 4a follow-ups round 2, R3 part 2 (Hein 2026-10-23): the additional
 * medical expenses tax credit an employer takes into account for an employee
 * 65 or older (section 6B(3)(a)(i); paragraph 9(6) of the Fourth Schedule).
 *
 * SARS Guide on the Determination of Medical Tax Credits, Issue 18:
 * - p. 31-32 "Employees' tax implications": the portion taken into account is
 *   "33,3% of the fees paid to a medical scheme or qualifying foreign fund as
 *   exceeds three times the amount of the MTC to which that person is
 *   entitled"; "Out-of-pocket expenses may not be taken into account for
 *   employees' tax purposes".
 * - p. 2: 65 or older on the last day of the year of assessment.
 * - p. 21-22, Example 16 (2026, AZ aged 67): fees R5 100 x 12 = 61 200, MTC
 *   R728 x 12 = 8 736, tax on R457 000 = 104 177 less rebates 17 235 and
 *   9 444 and the MTC. The guide adds the out-of-pocket R8 750 for the
 *   assessment; the employees' tax portion leaves it out:
 *   33,3% x (61 200 - 3 x 8 736) = 33,3% x 34 992 = 11 652.336.
 * 2027 figures (G21 2027 p. 3, 10-11): primary 17 820, secondary 9 765; MTC
 * R376 member, R376 first dependant, R254 each further one.
 */
import { describe, expect, it } from 'vitest';
import { annualTaxAfterCredits } from '@/modules/accounting/services/payroll/payeEngine';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayeYearToDate, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = {
  periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
};

describe('the annual credit (payeEngine)', () => {
  it('Example 16 without the out-of-pocket part: 33,3% x (61 200 - 3 x 8 736) = 11 652.336', () => {
    const r = annualTaxAfterCredits({ taxYear: 2026, ageAtPeriodEnd: 67, monthlyMedicalBeneficiaries: 2, annualTaxableIncome: 457_000, annualMedicalSchemeFees: 61_200 });
    expect(r.medicalCredits).toBe(8_736);
    expect(r.additionalMedicalCredits).toBeCloseTo(11_652.336, 6);
    // 104 177 - 17 235 - 9 444 - 8 736 = 68 762, less 11 652.336 = 57 109.664.
    expect(r.annualTax).toBeCloseTo(57_109.664, 6);
    expect(r.additionalMedicalCreditUsed).toBeCloseTo(11_652.336, 6);
  });

  it('2027, 67, member + 1, R5 100 a month, R360 000: 11 364.624 off 37 383', () => {
    // 33,3% x (61 200 - 3 x 9 024) = 33,3% x 34 128 = 11 364.624.
    // tax(360 000) = 44 118 + 26% x 114 900 = 73 992; - 17 820 - 9 765 - 9 024 = 37 383; - 11 364.624 = 26 018.376.
    const r = annualTaxAfterCredits({ taxYear: 2027, ageAtPeriodEnd: 67, monthlyMedicalBeneficiaries: 2, annualTaxableIncome: 360_000, annualMedicalSchemeFees: 61_200 });
    expect(r.additionalMedicalCredits).toBeCloseTo(11_364.624, 6);
    expect(r.annualTax).toBeCloseTo(26_018.376, 6);
  });

  it('under 65, or no fees, or fees not above three times the MTC: no credit, the tax as before', () => {
    const args = { taxYear: 2027, monthlyMedicalBeneficiaries: 2, annualTaxableIncome: 360_000 };
    expect(annualTaxAfterCredits({ ...args, ageAtPeriodEnd: 64, annualMedicalSchemeFees: 61_200 }).annualTax).toBe(73_992 - 17_820 - 9_024);
    expect(annualTaxAfterCredits({ ...args, ageAtPeriodEnd: 67 }).annualTax).toBe(37_383);
    // 3 x 9 024 = 27 072: fees of exactly that leave no excess.
    expect(annualTaxAfterCredits({ ...args, ageAtPeriodEnd: 67, annualMedicalSchemeFees: 27_072 }).annualTax).toBe(37_383);
  });

  it('it cannot take the tax below nil, and only what it took off counts as used', () => {
    // 67, R14 000: tax(168 000) = 30 240 - 17 820 - 9 765 = 2 655; member + 1: the 9 024 MTC takes all of it.
    const r = annualTaxAfterCredits({ taxYear: 2027, ageAtPeriodEnd: 67, monthlyMedicalBeneficiaries: 2, annualTaxableIncome: 168_000, annualMedicalSchemeFees: 61_200 });
    expect([r.annualTax, r.medicalCreditUsed, r.additionalMedicalCreditUsed]).toEqual([0, 2_655, 0]);
    // R22 000: tax(264 000) = 44 118 + 26% x 18 900 = 49 032; - 27 585 = 21 447; - 9 024 = 12 423; - 11 364.624 = 1 058.376.
    const s = annualTaxAfterCredits({ taxYear: 2027, ageAtPeriodEnd: 67, monthlyMedicalBeneficiaries: 2, annualTaxableIncome: 264_000, annualMedicalSchemeFees: 61_200 });
    expect(s.annualTax).toBeCloseTo(1_058.376, 6);
    // R18 000: tax(216 000) = 38 880 - 27 585 = 11 295; - 9 024 = 2 271 < 11 364.624: nil, 2 271 used.
    const t = annualTaxAfterCredits({ taxYear: 2027, ageAtPeriodEnd: 67, monthlyMedicalBeneficiaries: 2, annualTaxableIncome: 216_000, annualMedicalSchemeFees: 61_200 });
    expect([t.annualTax, t.additionalMedicalCreditUsed]).toEqual([0, 2_271]);
  });
});

describe('cumulative PAYE with the credit (payeCumulative)', () => {
  const month = (ytd: PayeYearToDate, fees = 5_100) => calculateCumulativePaye({
    taxYear: 2027, rebateAge: 67, monthlyMedicalBeneficiaries: 2, regularTaxable: 30_000, annualPayments: 0, medicalSchemeFees: fees, ytd,
  });
  const next = (ytd: PayeYearToDate, r: ReturnType<typeof month>, fees = 5_100): PayeYearToDate => ({
    periods: ytd.periods + 1, periodicTaxable: ytd.periodicTaxable + 30_000, annualPayments: 0,
    tablePaye: ytd.tablePaye + r.regular.monthlyPaye, medicalCredit: ytd.medicalCredit + r.medicalCredit,
    additionalMedicalCredit: ytd.additionalMedicalCredit + r.additionalMedicalCredit, medicalSchemeFees: ytd.medicalSchemeFees + fees,
  });

  it('a year at R30 000 and R5 100: PAYE 2 168.20/2 168.19, 4120 adds to 11 364.62, 4116 to 9 024', () => {
    // 26 018.376 / 12 = 2 168.198 a month; the cumulative rounding alternates 2 168.20 / 2 168.19.
    let ytd = NONE;
    const out: Array<ReturnType<typeof month>> = [];
    for (let i = 0; i < 12; i++) { const r = month(ytd); out.push(r); ytd = next(ytd, r); }
    expect(out.slice(0, 3).map(r => r.regular.monthlyPaye)).toEqual([2_168.2, 2_168.2, 2_168.19]);
    expect(Math.round(ytd.tablePaye * 100) / 100).toBe(26_018.38);
    expect(Math.round(ytd.additionalMedicalCredit * 100) / 100).toBe(11_364.62);
    expect(out[0]!.additionalMedicalCredit).toBe(947.05);
    expect(Math.round(ytd.medicalCredit * 100) / 100).toBe(9_024);
  });

  it('fees to date are annualised over the same months as pay: one month of fees after two without', () => {
    // n = 3, fees to date 5 100: annual 20 400 < 3 x 9 024, no credit, PAYE as the plain 37 383 x 3/12 - paid.
    const ytd = { ...NONE, periods: 2, periodicTaxable: 60_000, tablePaye: 6_230.5 };
    const r = month(ytd);
    expect(r.additionalMedicalCredit).toBe(0);
    expect(r.regular.monthlyPaye).toBe(3_115.25);
  });

  it('earlier months whose fees had no credit (before the change) are trued up in the first month calculated after it', () => {
    // Two months paid at 3 115.25 with R5 100 fees each; month 3: credit to date 33,3% x (15 300 - 3 x 9 024 x 3/12)
    // = 33,3% x 8 532 = 2 841.156; liability 37 383 x 3/12 - 2 841.156 = 6 504.594; less 6 230.50 paid = 274.09.
    const ytd = { ...NONE, periods: 2, periodicTaxable: 60_000, tablePaye: 6_230.5, medicalCredit: 1_504, medicalSchemeFees: 10_200 };
    const r = month(ytd);
    expect(r.regular.monthlyPaye).toBe(274.09);
    expect(r.additionalMedicalCredit).toBe(2_841.16);
  });

  it('no periodic pay yet (an annual payment alone): the fees to date are taken as they stand', () => {
    const r = calculateCumulativePaye({
      taxYear: 2027, rebateAge: 67, monthlyMedicalBeneficiaries: 2, regularTaxable: 0, annualPayments: 400_000, medicalSchemeFees: 61_200, ytd: NONE,
    });
    // AE 0; tax(400 000) = 79 998 + 31% x 16 900 = 85 237 - 27 585 - 9 024 - 11 364.624 = 37 263.376.
    expect(r.annualPaymentPaye).toBeCloseTo(37_263.38, 2);
    expect(r.additionalMedicalCredit).toBe(11_364.62);
  });
});

describe('the calculator passes the 4005 fees through', () => {
  const comp = (code: string, componentType: PayrollComponent['componentType']): PayrollComponent => ({
    id: `c-${code}`, name: code, sarsSourceCode: code, componentType, isTaxable: componentType === 'earning', isUifApplicable: true, isSdlApplicable: true,
  });
  const employee = (born: number) => ({
    id: 'e1', dateOfBirth: new Date(born, 5, 15), startDate: new Date(2015, 0, 1), uifExcluded: true, medicalAidMainMember: true, medicalAidDependantsCount: 1,
  }) as unknown as PayrollEmployee;
  const line = (born: number) => calculatePayrollLine({
    employee: employee(born), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 'defer',
    components: [{ component: comp('3601', 'earning'), amount: 30_000 }, { component: comp('4005', 'deduction'), amount: 5_100 }],
  });
  it('67 at the year end: 2 168.20 and 947.05 recorded; 64: 3 929 and nil', () => {
    expect([line(1959).paye.monthlyPaye, line(1959).additionalMedicalCredit]).toEqual([2_168.2, 947.05]);
    // Born June 1962: 64 on 28 Feb 2027. tax(360 000) = 73 992 - 17 820 - 9 024 = 47 148 / 12 = 3 929.
    expect([line(1962).paye.monthlyPaye, line(1962).additionalMedicalCredit]).toEqual([3_929, 0]);
  });
});
