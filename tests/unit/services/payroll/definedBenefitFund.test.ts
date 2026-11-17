/**
 * Wave 6 DBF: an employer's defined-benefit fund contribution valued per the Seventh Schedule para 12D(3), X = (A x B) - C
 * (A the fund member category factor, B retirement-funding income, C the employee's own contributions excluding AVCs and
 * buy-back: the Act's symbol definitions; the formula's form is an image there, read from the Sage Payroll Tax Pocket Guide
 * 2025-2026 s7.12.2: UNVERIFIED). 12D(2): a DC-only row stays the contribution itself. 12D(6): no value for retired members. From there it is the RF
 * treatment: a non-cash 3817 / 3825 benefit deemed paid by the employee into s11F (PAYE-GEN-01-G21 (2027) Rev 1 p. 10),
 * so the 27.5% cap binds on the total. Hand figures use the 2027 table: 18% to R245 100; primary rebate R17 820.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { costDefinedBenefitFund, dbFactorRefusal } from '@/modules/accounting/services/payroll/definedBenefitFund';
import { componentRfiRefusal } from '@/modules/accounting/services/payroll/payrollComponentRfi';
import { markNonCashEmployerBenefits } from '@/modules/accounting/services/payroll/employerContributions';
import { withRfiCosted } from '@/modules/accounting/services/payroll/payrollRunComponents';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee, ValidationResult } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: `Code ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over,
});
const employee: PayrollEmployee = {
  id: 'e1', companyId: 'c1', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false,
};
const salary = (n: number): EmployeeComponent => ({ component: comp('3601', { countsAsRfi: true }), amount: n });
const ee = (code: string, n: number, over: Partial<EmployeeComponent> = {}): EmployeeComponent =>
  ({ component: comp(code, { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount: n, ...over });
const db = (code: string, factor: number): EmployeeComponent => ({ component: comp(code), amount: 0, dbMemberCategoryFactor: factor });

/** As a run assembles a line (prepareRunComponents): fund benefits marked non-cash, then RFI rows and defined-benefit rows costed. */
const assemble = (components: EmployeeComponent[], warnings: ValidationResult[] = []) => withRfiCosted(markNonCashEmployerBenefits(components), warnings);
const line = (components: EmployeeComponent[]) => {
  const warnings: ValidationResult[] = [];
  const result = calculatePayrollLine({ employee, components: assemble(components, warnings), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 });
  return { ...result, validationResults: [...warnings, ...result.validationResults] };
};

describe('X = A x B - C [Seventh Schedule para 12D(3), via Sage Pocket Guide 2025-2026 s7.12.2]', () => {
  it('values the row from the factor, RFI and the matching employee contribution, and records all three', () => {
    const warnings: ValidationResult[] = [];
    const out = assemble([salary(30_000), ee('4001', 2_250), db('3817', 0.12)], warnings);
    // 0.12 x 30 000 - 2 250 = 1 350 (oracle case db-fund-12d-category-factor).
    expect(out[2]).toMatchObject({ amount: 1_350, isNonCash: true, dbMemberCategoryFactor: 0.12, rfiBase: 30_000, dbEmployeeContribution: 2_250 });
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([['DB_FUND_FACTOR_UNVERIFIED', 'warning']]);
    expect(warnings[0]!.message).toContain('12% of retirement-funding income');
  });

  it('C is the employee\'s contribution as costed this run, a percent_of_rfi row included (costed first)', () => {
    const out = assemble([salary(20_000), ee('4001', 0, { percentOfRfi: 0.075 }), db('3817', 0.2)]);
    // C = 7.5% x 20 000 = 1 500; X = 0.2 x 20 000 - 1 500 = 2 500.
    expect(out[2]).toMatchObject({ amount: 2_500, dbEmployeeContribution: 1_500 });
  });

  it('a provident fund (3825) is reduced by the 4003 contributions only, not a 4001', () => {
    const out = costDefinedBenefitFund([salary(20_000), ee('4001', 1_000), ee('4003', 600), db('3825', 0.1)], []);
    expect(out[3]).toMatchObject({ amount: 1_400, dbEmployeeContribution: 600 });
  });

  it('is nil, with a warning, when the employee pays more than A x B', () => {
    const warnings: ValidationResult[] = [];
    const out = costDefinedBenefitFund([salary(10_000), ee('4001', 1_500), db('3817', 0.1)], warnings);
    expect(out[2]!.amount).toBe(0);
    expect(warnings.map((w) => w.code)).toEqual(['DB_FUND_FACTOR_UNVERIFIED', 'DB_FUND_BENEFIT_NIL']);
  });

  it('a factor on a retirement annuity (3828) is costed at nil with an error: an RA fund is never defined-benefit', () => {
    const warnings: ValidationResult[] = [];
    const out = costDefinedBenefitFund([salary(10_000), db('3828', 0.1)], warnings);
    expect(out[1]!.amount).toBe(0);
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([['DB_FUND_FACTOR_WRONG_CODE', 'error']]);
  });

  it('leaves a line without a factor exactly as it was', () => {
    const rows = [salary(20_000), ee('4001', 1_500)];
    expect(costDefinedBenefitFund(rows, [])).toEqual(rows);
  });

  it('para 12D(2): a defined-contribution employer row (no factor) is still the contribution itself, untouched by DBF', () => {
    const warnings: ValidationResult[] = [];
    const dc: EmployeeComponent = { component: comp('3817'), amount: 1_800 };
    const marked = markNonCashEmployerBenefits([salary(20_000), ee('4001', 1_500), dc]);
    expect(costDefinedBenefitFund(marked, warnings)).toEqual(marked);
    expect(assemble([salary(20_000), ee('4001', 1_500), dc])[2]).toMatchObject({ amount: 1_800, isNonCash: true });
    expect(warnings).toEqual([]);
  });

  it('para 12D(6): on a line that pays a pension or annuity (a retired member) the factor row is nil, with an error', () => {
    for (const code of ['3603', '3610', '3653', '3660']) {
      const warnings: ValidationResult[] = [];
      const out = costDefinedBenefitFund([salary(20_000), { component: comp(code), amount: 5_000 }, db('3817', 0.12)], warnings);
      expect(out[2]!.amount).toBe(0);
      expect(warnings.map((w) => [w.code, w.severity])).toEqual([['DB_FUND_RETIRED_MEMBER', 'error']]);
    }
  });
});

describe('the s11F cap binds on the employee\'s and the deemed defined-benefit contribution together [G21 (2027) p. 10]', () => {
  // Oracle case db-fund-12d-s11f-cap-binds: X = 0.40 x 20 000 - 1 500 = 6 500; 1 500 + 6 500 = 8 000 > 27.5% x 26 500 = 7 287.50.
  const l = line([salary(20_000), ee('4001', 1_500), db('3817', 0.4)]);

  it('deducts 7 287.50, not the 8 000 contributed', () => {
    expect(l.retirementContributions).toBe(8_000);
    expect(l.retirementDeduction).toBe(7_287.5);
    // (26 500 - 7 287.50) x 12 = 230 550; 18% = 41 499; less 17 820 = 23 679; / 12.
    expect(l.paye.monthlyPaye).toBe(1_973.25);
  });

  it('is non-cash: taxed and in remuneration, not in gross or net pay; the breakdown keeps A, B and C', () => {
    expect(l.remuneration).toBe(26_500);
    expect(l.grossPay).toBe(20_000);
    expect(l.netPay).toBe(16_349.63);
    expect(l.componentBreakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({
      amount: 6_500, isNonCash: true, dbMemberCategoryFactor: 0.4, rfiBase: 20_000, dbEmployeeContribution: 1_500,
    });
    expect(l.validationResults.map((v) => v.code)).toContain('DB_FUND_FACTOR_UNVERIFIED');
  });

  it('the explanation shows the valuation as an unverified step, and PAYE carries the caution', () => {
    const steps = JSON.stringify(l.explanations.paye.steps);
    expect(steps).toContain('"label":"Fund member category factor (A)","amount":0.4');
    expect(steps).toContain('"status":"unverified"');
    expect(l.explanations.paye.caution).toContain('para 12D(3)');
  });
});

describe('dbFactorRefusal: where a factor may go (the service judges it before the insert)', () => {
  const ok = { componentType: 'earning', code: '3817', factor: 0.12, percentOfRfi: null, amount: 0, isRecurring: true };
  it('accepts a recurring, amount-0 pension or provident contribution earning', () => {
    expect(dbFactorRefusal(ok)).toBeNull();
    expect(dbFactorRefusal({ ...ok, code: ' 3825 ' })).toBeNull();
  });
  it('refuses a factor beside a percent_of_rfi', () => {
    expect(dbFactorRefusal({ ...ok, percentOfRfi: 0.15 })).toMatch(/cannot be on the same assignment/);
  });
  it('refuses a retirement annuity, a deduction, an amount, a once-off and a factor out of range', () => {
    expect(dbFactorRefusal({ ...ok, code: '3828' })).toMatch(/retirement annuity/);
    expect(dbFactorRefusal({ ...ok, componentType: 'deduction', code: '4001' })).toMatch(/3817/);
    expect(dbFactorRefusal({ ...ok, amount: 100 })).toMatch(/amount 0/);
    expect(dbFactorRefusal({ ...ok, isRecurring: false })).toMatch(/recurring/);
    for (const factor of [0, -0.1, 1.2, 0.12345, Number.NaN, '0.12']) expect(dbFactorRefusal({ ...ok, factor })).toMatch(/fraction/);
  });
});

describe('creating the component: a defined-benefit pension or provident fund is accepted, an RA is not', () => {
  const er = (code: string) => ({ componentType: 'earning', code, isTaxable: true, countsAsRfi: undefined, fundType: 'defined_benefit' });
  it('3817 and 3825 pass; 3828 is refused', () => {
    expect(componentRfiRefusal(er('3817'))).toBeNull();
    expect(componentRfiRefusal(er('3825'))).toBeNull();
    expect(componentRfiRefusal(er('3828'))).toMatch(/never a DEFINED-BENEFIT fund/);
    expect(componentRfiRefusal({ ...er('3817'), fundType: undefined })).toMatch(/needs fundType/);
  });
});
