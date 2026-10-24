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

  it('2026 tax year, a year at R30 000 and R5 100, member + 1: 2 297.06 / 2 297.05 / 2 297.06 ..., 4120 adds to 11 652.34', () => {
    // 2026: tax(360 000) = 42 678 + 26% x 122 900 = 74 632; - 17 235 - 9 444 = 47 953; MTC 728 x 12 = 8 736: 39 217.
    // AMTC 33,3% x (61 200 - 3 x 8 736) = 11 652.336: 27 564.664 a year, 2 297.0553 a month.
    const in2026 = (ytd: PayeYearToDate) => calculateCumulativePaye({
      taxYear: 2026, rebateAge: 67, monthlyMedicalBeneficiaries: 2, regularTaxable: 30_000, annualPayments: 0, medicalSchemeFees: 5_100, ytd,
    });
    let ytd = NONE;
    const out: Array<ReturnType<typeof in2026>> = [];
    for (let i = 0; i < 12; i++) { const r = in2026(ytd); out.push(r); ytd = next(ytd, r); }
    expect(out.slice(0, 3).map(r => r.regular.monthlyPaye)).toEqual([2_297.06, 2_297.05, 2_297.06]);
    expect(Math.round(ytd.tablePaye * 100) / 100).toBe(27_564.66);
    expect(out[0]!.additionalMedicalCredit).toBe(971.03);
    expect(Math.round(ytd.additionalMedicalCredit * 100) / 100).toBe(11_652.34);
    expect(Math.round(ytd.medicalCredit * 100) / 100).toBe(8_736);
  });

  it('a single beneficiary (member only), R3 000 fees: 33,3% x (36 000 - 3 x 4 512) = 7 480.512', () => {
    // tax(360 000) = 73 992 - 27 585 - 4 512 = 41 895; - 7 480.512 = 34 414.488 / 12 = 2 867.874.
    const r = calculateCumulativePaye({
      taxYear: 2027, rebateAge: 67, monthlyMedicalBeneficiaries: 1, regularTaxable: 30_000, annualPayments: 0, medicalSchemeFees: 3_000, ytd: NONE,
    });
    expect([r.regular.monthlyPaye, r.additionalMedicalCredit, r.medicalCredit]).toEqual([2_867.87, 623.38, 376]);
  });

  it('fees exactly three times the MTC (R2 256 a month for member + 1): no credit, PAYE 37 383 / 12', () => {
    const r = month(NONE, 2_256);
    expect([r.regular.monthlyPaye, r.additionalMedicalCredit]).toEqual([3_115.25, 0]);
  });

  it('no medical aid beneficiaries on the employee (member flag off, no dependants): no additional credit either', () => {
    // 4005 fees but no scheme membership recorded: no MTC, and no AMTC (round 2 review). tax 73 992 - 27 585 = 46 407.
    const r = calculateCumulativePaye({
      taxYear: 2027, rebateAge: 67, monthlyMedicalBeneficiaries: 0, regularTaxable: 30_000, annualPayments: 0, medicalSchemeFees: 5_100, ytd: NONE,
    });
    expect([r.regular.monthlyPaye, r.additionalMedicalCredit]).toEqual([3_867.25, 0]);
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
  it('4005 fees but no medical aid membership on the employee: the line warns, the PAYE is as before (confirmation 2)', () => {
    const noMembers = (born: number) => calculatePayrollLine({
      employee: { ...employee(born), medicalAidMainMember: false, medicalAidDependantsCount: 0 } as PayrollEmployee,
      period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 'defer',
      components: [{ component: comp('3601', 'earning'), amount: 30_000 }, { component: comp('4005', 'deduction'), amount: 5_100 }],
    });
    const old = noMembers(1959);
    // 67: 73 992 - 17 820 - 9 765 = 46 407 / 12, no MTC and no additional credit.
    expect(old.paye.monthlyPaye).toBe(3_867.25);
    const warning = old.validationResults.find(v => v.code === 'MEDICAL_FEES_WITHOUT_MEMBERSHIP');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toMatch(/R5100\.00.*4005.*no medical tax credit.*65.*over-deducted/);
    const young = noMembers(1985).validationResults.find(v => v.code === 'MEDICAL_FEES_WITHOUT_MEMBERSHIP');
    expect(young?.message).toMatch(/over-deducted/);
    expect(young?.message).not.toMatch(/65/);
    expect(line(1959).validationResults.map(v => v.code)).not.toContain('MEDICAL_FEES_WITHOUT_MEMBERSHIP');
  });

  it('65 only the day after the year ends (born 1 Mar 1962): 64 on its last day, no credit', () => {
    const at64 = calculatePayrollLine({
      employee: { ...employee(1962), dateOfBirth: new Date(1962, 2, 1) } as PayrollEmployee, period: { year: 2026, month: 3 }, taxYear: 2027,
      annualPayrollEstimate: 'defer',
      components: [{ component: comp('3601', 'earning'), amount: 30_000 }, { component: comp('4005', 'deduction'), amount: 5_100 }],
    });
    expect([at64.paye.monthlyPaye, at64.additionalMedicalCredit]).toEqual([3_929, 0]);
  });

  it('65 on the last day of the year (born 28 Feb 1962) already qualifies', () => {
    const at65 = calculatePayrollLine({
      employee: { ...employee(1962), dateOfBirth: new Date(1962, 1, 28) } as PayrollEmployee, period: { year: 2026, month: 3 }, taxYear: 2027,
      annualPayrollEstimate: 'defer',
      components: [{ component: comp('3601', 'earning'), amount: 30_000 }, { component: comp('4005', 'deduction'), amount: 5_100 }],
    });
    expect([at65.paye.monthlyPaye, at65.additionalMedicalCredit]).toEqual([2_168.2, 947.05]);
  });

  it('67 at the year end: 2 168.20 and 947.05 recorded; 64: 3 929 and nil', () => {
    expect([line(1959).paye.monthlyPaye, line(1959).additionalMedicalCredit]).toEqual([2_168.2, 947.05]);
    // Born June 1962: 64 on 28 Feb 2027. tax(360 000) = 73 992 - 17 820 - 9 024 = 47 148 / 12 = 3 929.
    expect([line(1962).paye.monthlyPaye, line(1962).additionalMedicalCredit]).toEqual([3_929, 0]);
  });
});
