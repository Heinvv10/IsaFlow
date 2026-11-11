/**
 * Employer retirement fund contributions in the payroll line (wave 5 RF; employerContributions.ts, rfi.ts).
 *
 * PAYE-GEN-01-G21 (2027) Rev 1 p. 10, "Retirement fund contributions": from 1 March 2016 an employer's contribution
 * "will be a taxable fringe benefit and a deemed contribution in the hands of the employee. Therefore, current
 * contributions = contributions actually made by the employee plus employer contributions"; the deduction is limited
 * to the lesser of R430 000 and 27.5% of the higher of Fourth Schedule remuneration or taxable income.
 * SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26): 3817 / 3825 / 3828 are the taxable benefits of an employer's
 * pension / provident / retirement annuity contributions (p. 94-95); 4001 / 4003 / 4006 are contributions "paid and
 * 'deemed paid' by employee", the deemed part being that benefit (p. 101-102).
 * Hand figures use the 2027 statutory table: 18% to R245 100, then R44 118 + 26%; primary rebate R17 820.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { markNonCashEmployerBenefits } from '@/modules/accounting/services/payroll/employerContributions';
import { costPercentOfRfi } from '@/modules/accounting/services/payroll/rfi';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: `Code ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: false, isSdlApplicable: false, ...over,
});
const employee: PayrollEmployee = {
  id: 'e1', companyId: 'c1', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: true, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false,
};
/** As a run assembles a line: the employer's benefit marked non-cash, then the percent rows costed on RFI. */
const run = (components: EmployeeComponent[]) => calculatePayrollLine({
  employee, components: costPercentOfRfi(markNonCashEmployerBenefits(components)).components,
  period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});
const salary = (n: number): EmployeeComponent => ({ component: comp('3601', { countsAsRfi: true }), amount: n });
const commission = (n: number): EmployeeComponent => ({ component: comp('3606'), amount: n });
const ee = (code: string, n: number): EmployeeComponent => ({ component: comp(code, { componentType: 'deduction' }), amount: n });
const er = (code: string, pct: number): EmployeeComponent => ({ component: comp(code), amount: 0, percentOfRfi: pct });

describe('an employer pension contribution: a fringe benefit and a deemed contribution [G21 (2027) p. 10]', () => {
  // The oracle case rf-employer-contribution-15pct-rfi-cap-binds-on-total.
  const line = run([salary(20_000), ee('4001', 4_000), er('3817', 0.15)]);

  it('the s11F cap binds on employee + employer together: 27.5% x 23 000 = 6 325 of the 7 000', () => {
    expect(line.retirementContributions).toBe(7_000);
    expect(line.retirementDeduction).toBe(6_325);
    // (23 000 - 6 325) x 12 = 200 100; 18% = 36 018; less 17 820 = 18 198; / 12.
    expect(line.paye.monthlyPaye).toBe(1_516.5);
  });

  it('is non-cash: taxed, in remuneration, not in gross or net pay', () => {
    expect(line.periodicTaxable).toBe(23_000);
    expect(line.remuneration).toBe(23_000);
    expect(line.grossPay).toBe(20_000);
    expect(line.netPay).toBe(20_000 - 4_000 - 1_516.5);
    expect(line.componentBreakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({
      amount: 3_000, isNonCash: true, percentOfRfi: 0.15, rfiBase: 20_000,
    });
    expect(line.validationResults.map((v) => v.code)).not.toContain('EMPLOYER_FUND_BENEFIT_NOT_DEEMED');
  });

  it('the R430 000 a year cap binds on the total too (R35 833.33 a month)', () => {
    const high = run([salary(200_000), ee('4001', 30_000), er('3817', 0.1)]);
    expect(high.retirementContributions).toBe(50_000);
    expect(high.retirementDeduction).toBe(35_833.33);
  });
});

describe('RFI is the fund base only, never the s11F base [G21 (2027) p. 10]', () => {
  it('a non-RFI commission is still in the 27.5% base: 8 000 of contributions allowed in full on 32 000', () => {
    // RFI 20 000 -> the employer's 10% = 2 000. Remuneration 20 000 + 10 000 + 2 000 = 32 000; 27.5% = 8 800 >= 8 000.
    const line = run([salary(20_000), commission(10_000), ee('4001', 6_000), er('3817', 0.1)]);
    expect(line.retirementDeduction).toBe(8_000);
    // (32 000 - 8 000) x 12 = 288 000; 44 118 + 26% x 42 900 = 55 272; less 17 820 = 37 452; / 12.
    expect(line.paye.monthlyPaye).toBe(3_121);
  });
});

describe('provident (3825) and retirement annuity (3828) contributions are deemed alike [BRS V25.3.0 p. 95, 101-102]', () => {
  for (const [code, own] of [['3825', '4003'], ['3828', '4006']] as const) {
    it(`${code} with ${own}`, () => {
      const line = run([salary(20_000), ee(own, 4_000), er(code, 0.15)]);
      expect([line.retirementContributions, line.retirementDeduction, line.paye.monthlyPaye, line.grossPay]).toEqual([7_000, 6_325, 1_516.5, 20_000]);
    });
  }
});

describe('what is not deemed', () => {
  it('a non-taxable 3817 is refused on the line (error) and adds nothing to the s11F pool', () => {
    const line = run([salary(20_000), ee('4001', 4_000), { component: comp('3817', { isTaxable: false }), amount: 3_000 }]);
    expect(line.retirementContributions).toBe(4_000);
    const w = line.validationResults.find((v) => v.code === 'RETIREMENT_BENEFIT_NOT_TAXABLE');
    expect(w?.severity).toBe('error');
  });
  it('a 3817 that reaches the calculator as cash (not marked by a run) is taxed but not deemed, and warned', () => {
    const line = calculatePayrollLine({
      employee, components: [salary(20_000), { component: comp('3817'), amount: 3_000 }],
      period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
    });
    expect([line.retirementContributions, line.grossPay]).toEqual([0, 23_000]);
    expect(line.validationResults.map((v) => v.code)).toContain('EMPLOYER_FUND_BENEFIT_NOT_DEEMED');
  });
});

describe('markNonCashEmployerBenefits', () => {
  it('marks 3817 / 3825 / 3828 earnings non-cash, whatever the gross-up opt-in (that is for 3810)', () => {
    for (const grossUp of [false, true]) {
      const marked = markNonCashEmployerBenefits([salary(1), { component: comp('3817'), amount: 1 }, { component: comp(' 3825 '), amount: 1 },
        { component: comp('3828'), amount: 1 }, ee('4001', 1)], grossUp);
      expect(marked.map((c) => c.isNonCash === true)).toEqual([false, true, true, true, false]);
    }
  });
});

describe('an assignment from before RF keeps the cash treatment (migration 975 opt-out): no figure change on deploy', () => {
  const kept: EmployeeComponent = { component: comp('3817'), amount: 3_000, employerFundAsCash: true };
  it('is paid as cash, taxed, not deemed, exactly as before RF, and says how to switch', () => {
    const line = run([salary(20_000), ee('4001', 4_000), kept]);
    const before = calculatePayrollLine({
      employee, components: [salary(20_000), ee('4001', 4_000), { component: comp('3817'), amount: 3_000 }],
      period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
    });
    expect([line.grossPay, line.netPay, line.paye.monthlyPaye, line.retirementContributions]).toEqual([before.grossPay, before.netPay, before.paye.monthlyPaye, 4_000]);
    expect(line.grossPay).toBe(23_000);
    const w = line.validationResults.find((v) => v.code === 'EMPLOYER_FUND_KEPT_AS_CASH');
    expect(w?.message).toMatch(/end this assignment and assign the component again/);
    expect(line.validationResults.map((v) => v.code)).not.toContain('EMPLOYER_FUND_BENEFIT_NOT_DEEMED');
  });
});
