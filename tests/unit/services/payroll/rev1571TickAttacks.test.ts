/**
 * Breaker delta repros for PR #1571 (DBF), copied as given: two marked 4001 rows on a DB line must not be taken into C silently.
 */
import { describe, expect, it } from 'vitest';
import { markNonCashEmployerBenefits } from '@/modules/accounting/services/payroll/employerContributions';
import { withRfiCosted } from '@/modules/accounting/services/payroll/payrollRunComponents';
import type { EmployeeComponent, PayrollComponent, ValidationResult } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}-${over.name ?? ''}`, name: over.name ?? code, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over,
});
const salary = (n: number): EmployeeComponent => ({ component: comp('3601', { countsAsRfi: true }), amount: n });
const ee = (code: string, n: number, name: string, marked: boolean): EmployeeComponent =>
  ({ component: comp(code, { name, componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount: n, ...(marked ? { dbFundMemberContribution: true } : {}) });
const db = (factor: number, paid: number): EmployeeComponent => ({ component: comp('3817'), amount: paid, dbMemberCategoryFactor: factor });

describe('TICK: a voluntary 4001 ticked beside the compulsory one', () => {
  it('is not silently taken into C: two ticked 4001 rows at least warn (one is likely an AVC)', () => {
    const w: ValidationResult[] = [];
    withRfiCosted(markNonCashEmployerBenefits([salary(20_000), ee('4001', 1_500, 'Pension', true), ee('4001', 1_000, 'Pension AVC', true), db(0.4, 2_200)]), w);
    expect(w.some((x) => /mark|AVC|voluntary|more than one/i.test(x.message) && x.code !== 'DB_FUND_FACTOR_UNVERIFIED')).toBe(true);
  });
});
describe('TICK: a ticked 4001 with no DB factor on the line', () => {
  it('does nothing (control)', () => {
    const w: ValidationResult[] = [];
    const rows = [salary(20_000), ee('4001', 1_500, 'Pension', true)];
    expect(withRfiCosted(markNonCashEmployerBenefits(rows), w)).toEqual(rows);
    expect(w).toEqual([]);
  });
});
