/**
 * Adversarial repros for PR #1571 (DBF) at 63754b32fa. Each `it` asserts the rule; a red one is a confirmed break.
 * Copied from the review; the ASSERTIONS are unchanged. The inputs follow the round's rulings, which change what a
 * row says: the employee's compulsory contribution to the fund is marked (`own`, db_fund_member_contribution, M1), and a
 * defined-benefit row's stored amount is what the employer pays the fund (H), read for 4472 as `employerPaid`.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { costDefinedBenefitFund } from '@/modules/accounting/services/payroll/definedBenefitFund';
import { markNonCashEmployerBenefits } from '@/modules/accounting/services/payroll/employerContributions';
import { withRfiCosted } from '@/modules/accounting/services/payroll/payrollRunComponents';
import { employerFundContributionFields } from '@/modules/accounting/services/payroll/easyFileRetirementFields';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee, ValidationResult } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}-${over.name ?? ''}`, name: over.name ?? `Code ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over,
});
const employee: PayrollEmployee = {
  id: 'e1', companyId: 'c1', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false,
};
const salary = (n: number): EmployeeComponent => ({ component: comp('3601', { countsAsRfi: true }), amount: n });
const ee = (code: string, n: number, name?: string): EmployeeComponent =>
  ({ component: comp(code, { name, componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount: n });
const db = (code: string, factor: number, paid = 0): EmployeeComponent => ({ component: comp(code), amount: paid, dbMemberCategoryFactor: factor });
const own = (code: string, n: number, name?: string): EmployeeComponent => ({ ...ee(code, n, name), dbFundMemberContribution: true });
const assemble = (cs: EmployeeComponent[], w: ValidationResult[] = []) => withRfiCosted(markNonCashEmployerBenefits(cs), w);
const dbRow = (out: EmployeeComponent[]) => out.find((c) => c.dbMemberCategoryFactor != null)!;

describe('ATTACK 1: C must exclude additional voluntary contributions (para 12D(3) "C")', () => {
  it('an AVC entered as a 4001 does not reduce X', () => {
    // A 0.40, B 20 000, C 1 500 (compulsory) => X 6 500. The R1 000 AVC is excluded from C by the Act.
    const out = assemble([salary(20_000), own('4001', 1_500, 'Pension'), ee('4001', 1_000, 'Pension AVC'), db('3817', 0.4)]);
    expect(dbRow(out).amount).toBe(6_500);
  });
  it('a contribution to a SECOND, unrelated pension fund does not reduce X', () => {
    const out = assemble([salary(20_000), own('4001', 1_500, 'DB fund'), ee('4001', 800, 'Other DC fund'), db('3817', 0.4)]);
    expect(dbRow(out).amount).toBe(6_500);
  });
});

describe('ATTACK 2: para 12D(6) proxy misfires on a working member who also receives an annuity', () => {
  it('an active employee paid a 3610 annuity on the same line keeps X = A x B - C, with no error', () => {
    const w: ValidationResult[] = [];
    const out = assemble([salary(20_000), { component: comp('3610', { name: 'Annuity' }), amount: 3_000 }, own('4001', 1_500), db('3817', 0.4)], w);
    expect(dbRow(out).amount).toBe(6_500);
    expect(w.filter((x) => x.severity === 'error')).toEqual([]);
  });
  it('a dormant R0 3603 assignment alone does not make the employee a retired member', () => {
    const w: ValidationResult[] = [];
    const out = assemble([salary(20_000), { component: comp('3603', { name: 'Pension' }), amount: 0 }, own('4001', 1_500), db('3817', 0.4)], w);
    expect(dbRow(out).amount).toBe(6_500);
  });
});

describe('ATTACK 3: the employer contribution paid (4472 / GL 2175) is not X', () => {
  // BRS V25.3.0 p. 103: 4472 "Employer's pension fund contributions paid for the benefit of employee". For a DB fund the
  // employer pays its contribution rate, X is only the fringe value. When C > A x B, X is nil but the employer still pays.
  it('when X is nil the line still carries an employer pension contribution to report as 4472 and book to 2175', () => {
    const w: ValidationResult[] = [];
    const out = assemble([salary(10_000), own('4001', 1_500), db('3817', 0.1, 1_200)], w);
    expect(dbRow(out).amount).toBe(0); // X nil (engine's floor)
    const fields = employerFundContributionFields(out.filter((c) => c.component.sarsSourceCode === '3817').map((c) => ({ sourceCode: '3817', amount: c.amount, employerPaid: c.dbEmployerContribution })));
    expect(fields.some((f) => f.startsWith('4472'))).toBe(true);
  });
});

describe('ATTACK 4: two DB rows of the same kind each subtract the whole C', () => {
  it('C is not subtracted twice across two 3817 factor rows (two categories / funds)', () => {
    const out = costDefinedBenefitFund([salary(20_000), own('4001', 1_500), db('3817', 0.2), db('3817', 0.2)], []);
    const total = out.filter((c) => c.dbMemberCategoryFactor != null).reduce((s, c) => s + c.amount, 0);
    // A x B over both = 8 000, less C 1 500 = 6 500 in total.
    expect(total).toBe(6_500);
  });
});

describe('CONTROL: oracle db-fund-12d-s11f-cap-binds through the real calculator', () => {
  it('PAYE 1 973.25, net 16 349.63', () => {
    const w: ValidationResult[] = [];
    const r = calculatePayrollLine({ employee, components: assemble([salary(20_000), own('4001', 1_500), db('3817', 0.4)], w), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 });
    expect([r.paye.monthlyPaye, r.netPay]).toEqual([1_973.25, 16_349.63]);
  });
});

describe('CONTROL: the earning explanation recomputes X from its A, B, C to the cent', () => {
  it.each([[20_000, 1_500, 0.4], [30_000, 2_250, 0.12], [10_000, 1_500, 0.1], [33_333.33, 1_234.57, 0.1234]])('B %s C %s A %s', (b, c, a) => {
    const r = calculatePayrollLine({ employee, components: assemble([salary(b), own('4001', c), db('3817', a)]), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 });
    const steps = JSON.stringify(r.explanations);
    const found = (JSON.parse(steps) as unknown);
    const all: Array<{ label?: string; amount?: number; children?: Array<{ key: string; amount: number }> }> = [];
    const walk = (n: unknown) => { if (n && typeof n === 'object') { const o = n as Record<string, unknown>; if (Array.isArray(o.children) && (o.children as Array<{ key: string }>).some((k) => k.key?.endsWith('.factor'))) all.push(o as never); Object.values(o).forEach(walk); } };
    walk(found);
    expect(all.length).toBeGreaterThan(0);
    const s = all[0]!;
    const [fa, fb, fc] = ['factor', 'rfi', 'own'].map((k) => s.children!.find((x) => x.key.endsWith(`.${k}`))!.amount);
    expect(s.amount).toBe(Math.max(0, Math.round((fa! * fb! - fc!) * 100) / 100));
  });
});
