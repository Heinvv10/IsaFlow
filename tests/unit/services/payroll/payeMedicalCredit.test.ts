/**
 * PAYE 4a follow-ups round 2, R3: the medical scheme fees tax credit a line's
 * PAYE took into account (PayrollLineResult.medicalCredit, stored in
 * payroll_run_lines.medical_credit, migration 926), for the e@syFile 4116.
 *
 * Definition (payeCumulative.ts): the credit inside the PAYE liability to
 * date, less the credits already recorded on the employee's earlier lines of
 * the tax year (ytd.medicalCredit). Inside the liability the credit is what
 * annualTaxAfterCredits actually took off: min(annual credit, tax after
 * rebates), pro-rated n/12 like the rest of the liability, plus what the
 * annual payments used on top. So the year's lines add up to the credit inside
 * the year's liability, and a line never records a credit the PAYE did not use.
 *
 * Hand figures, 2027 (G21 2027 p. 3, p. 10-11): 18% to 245 100; primary rebate
 * 17 820, secondary 9 765; credit R376 a month for the member and the first
 * dependant, R254 each further dependant.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
import type {
  EmployeeComponent, PayeYearToDate, PayrollComponent, PayrollEmployee,
} from '@/modules/accounting/services/payroll/payrollTypes';

const NONE: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0 };
const base = { taxYear: 2027, rebateAge: 40 };
const comp = (code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...extra,
});
const employee = (beneficiaries: number, birthYear = 1985): PayrollEmployee => ({
  id: 'e1', companyId: 'c1', employeeNumber: 'E1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2015, 0, 1), dateOfBirth: new Date(birthYear, 0, 1), uifExcluded: true,
  medicalAidMainMember: beneficiaries > 0, medicalAidDependantsCount: Math.max(0, beneficiaries - 1),
});

/** A year month by month, carrying the year-to-date as the run service and loadPayeYearToDate do. */
function year(salaries: number[], beneficiaries: number) {
  let ytd = NONE;
  return salaries.map((s) => {
    const r = calculateCumulativePaye({ ...base, regularTaxable: s, annualPayments: 0, ytd, monthlyMedicalBeneficiaries: beneficiaries });
    ytd = {
      periods: ytd.periods + 1, periodicTaxable: ytd.periodicTaxable + s, annualPayments: 0,
      tablePaye: ytd.tablePaye + r.regular.monthlyPaye, medicalCredit: ytd.medicalCredit + r.medicalCredit,
    };
    return r;
  });
}

describe('R3: the medical credit a line applied', () => {
  it('first period, credit fully used: the monthly credit (R20 000, member + 1: 752 = 2 x 376)', () => {
    // tax(240 000) = 43 200 - 17 820 = 25 380; credit 9 024 a year, all used; PAYE (25 380 - 9 024) / 12 = 1 363.
    const r = calculateCumulativePaye({ ...base, regularTaxable: 20_000, annualPayments: 0, ytd: NONE, monthlyMedicalBeneficiaries: 2 });
    expect(r.medicalCredit).toBe(752);
    expect(r.regular.monthlyPaye).toBe(1_363);
  });

  it('the credit wipes the tax: only what it took off is recorded (R10 000, member only: 315, PAYE nil)', () => {
    // tax(120 000) = 21 600 - 17 820 = 3 780 < the 4 512 credit: 3 780 used, 315 a month.
    const r = calculateCumulativePaye({ ...base, regularTaxable: 10_000, annualPayments: 0, ytd: NONE, monthlyMedicalBeneficiaries: 1 });
    expect(r.regular.monthlyPaye).toBe(0);
    expect(r.medicalCredit).toBe(315);
  });

  it('under the threshold, nothing to take a credit off: nil', () => {
    // tax(96 000) = 17 280 < the 17 820 rebate.
    const r = calculateCumulativePaye({ ...base, regularTaxable: 8_000, annualPayments: 0, ytd: NONE, monthlyMedicalBeneficiaries: 3 });
    expect(r.medicalCredit).toBe(0);
  });

  it('no medical aid: nil', () => {
    expect(calculateCumulativePaye({ ...base, regularTaxable: 50_000, annualPayments: 0, ytd: NONE, monthlyMedicalBeneficiaries: 0 }).medicalCredit).toBe(0);
  });

  it('a year at the same pay: 752 every month, 9 024 for the year (member + 1, 2 x 376 x 12)', () => {
    const months = year(Array(12).fill(20_000), 2);
    expect(months.map(m => m.medicalCredit)).toEqual(Array(12).fill(752));
    expect(months.reduce((t, m) => t + m.medicalCredit, 0)).toBe(9_024);
  });

  it('member + 3 dependants: 376 + 376 + 254 + 254 = 1 260 a month', () => {
    const r = calculateCumulativePaye({ ...base, regularTaxable: 30_000, annualPayments: 0, ytd: NONE, monthlyMedicalBeneficiaries: 4 });
    expect(r.medicalCredit).toBe(1_260);
  });

  it('an annual payment that lets more of the credit be used records that too (R10 000 + R20 000 bonus, member: 1 047)', () => {
    // AE 120 000: 3 780 used of 4 512 (315 for the month). AE + bonus 140 000: 25 200 - 17 820 = 7 380, all 4 512 used,
    // so the bonus used 732 more: 315 + 732 = 1 047. PAYE: regular nil, bonus 7 380 - 4 512 - 0 = 2 868.
    const r = calculateCumulativePaye({ ...base, regularTaxable: 10_000, annualPayments: 20_000, ytd: NONE, monthlyMedicalBeneficiaries: 1 });
    expect([r.regular.monthlyPaye, r.annualPaymentPaye]).toEqual([0, 2_868]);
    expect(r.medicalCredit).toBe(1_047);
  });

  it('earlier lines with no record (before migration 926) are carried by the first line that has one', () => {
    // Month 3 at R20 000, member + 1: the credit to date is 9 024 x 3/12 = 2 256, none recorded before.
    const ytd = { periods: 2, periodicTaxable: 40_000, annualPayments: 0, tablePaye: 2_726, medicalCredit: 0 };
    const r = calculateCumulativePaye({ ...base, regularTaxable: 20_000, annualPayments: 0, ytd, monthlyMedicalBeneficiaries: 2 });
    expect(r.medicalCredit).toBe(2_256);
    expect(r.regular.monthlyPaye).toBe(1_363);
  });

  it('a credit the liability no longer holds (dependants removed mid-year) is a negative record, so the year still adds up', () => {
    // Months 1-2 recorded 752 each (member + 1). Month 3 member only: credit to date 4 512 x 3/12 = 1 128, less 1 504.
    const ytd = { periods: 2, periodicTaxable: 40_000, annualPayments: 0, tablePaye: 2_726, medicalCredit: 1_504 };
    const r = calculateCumulativePaye({ ...base, regularTaxable: 20_000, annualPayments: 0, ytd, monthlyMedicalBeneficiaries: 1 });
    expect(r.medicalCredit).toBe(-376);
  });

  it('65 and older: the credit is taken after the secondary rebate', () => {
    // Age 66, R14 000: tax(168 000) = 30 240 - 17 820 - 9 765 = 2 655 < 9 024: 2 655 used, 221.25 a month.
    const r = calculateCumulativePaye({ taxYear: 2027, rebateAge: 66, regularTaxable: 14_000, annualPayments: 0, ytd: NONE, monthlyMedicalBeneficiaries: 2 });
    expect(r.regular.monthlyPaye).toBe(0);
    expect(r.medicalCredit).toBe(221.25);
  });

  it('the calculator returns it on the line; a severance-only line (no table PAYE) records nil', () => {
    const salary: EmployeeComponent[] = [{ component: comp('3601'), amount: 20_000 }];
    const line = calculatePayrollLine({ employee: employee(2), components: salary, period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 'defer' });
    expect(line.medicalCredit).toBe(752);
    const severance = calculatePayrollLine({
      employee: employee(2),
      components: [{ component: comp('3901', { isUifApplicable: false }), amount: 50_000, directive: { id: 'd', number: '1', paye: 5_000 } }],
      period: { year: 2026, month: 7 }, taxYear: 2027, annualPayrollEstimate: 'defer',
      ytd: { periods: 3, periodicTaxable: 60_000, annualPayments: 0, tablePaye: 4_089, medicalCredit: 0 }, notEmployedInPeriod: true,
    });
    expect(severance.medicalCredit).toBe(0);
  });
});
