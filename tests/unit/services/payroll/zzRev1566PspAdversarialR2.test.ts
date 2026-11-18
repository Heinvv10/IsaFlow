/** Round 2 adversarial checks for #1566: a PSP under an IRP3(b) directive, and the flat base. */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';
import { pspTaxBasis } from '@/modules/accounting/services/payroll/pspLineRules';
import { buildCaseInput, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

function line(entity: 'company' | 'trust', over: Partial<PayrollLineInput> = {}, extra: EmployeeComponent[] = []) {
  const c: OracleCase = {
    id: `adv2-${entity}`, source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: 2026, month: 6 }, taxYear: 2027,
      employee: { dateOfBirth: '1990-01-01', startDate: '2020-03-01', taxStatus: `personal_service_${entity}`, uifExcluded: false,
        medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false },
      employerAnnualRemuneration: 2_000_000,
      components: [{ code: '3601', name: 'Fees', type: 'earning', amount: 40_000, taxable: true, uif: true, sdl: true }],
    },
    expected: {},
  };
  const input = buildCaseInput(c);
  return calculatePayrollLine({ ...input, components: [...input.components, ...extra], ...over });
}
const comp = (code: string, type: 'earning' | 'deduction', amount: number, more: Partial<EmployeeComponent['component']> = {}): EmployeeComponent => ({
  component: { id: `c-${code}`, name: code, sarsSourceCode: code, componentType: type, isTaxable: true, isUifApplicable: false, isSdlApplicable: true, ...more },
  amount,
});
const directive = (type: 'fixed_percentage' | 'fixed_amount', rate: number | null, fixedAmount: number | null) => ({
  regularPayDirective: { current: { id: 'd1', number: '1234567890', type, rate, fixedAmount, endsOn: '2027-02-28', effectiveDate: '2026-03-01' }, ended: null },
});

describe('a PSP under an IRP3(b) directive', () => {
  it('PAYE is the directive\'s; the line keeps the PSP flag (off natural-person filings) and the directive flag; no UIF/ETI; basis says directive', () => {
    const l = line('trust', directive('fixed_percentage', 0.2, null));
    const flags = l.validationResults.filter((v) => v.code === 'PAYE_OUTSIDE_TABLES').map((v) => v.treatment).sort();
    expect({ paye: l.paye.monthlyPaye, uif: l.uif.employeeContribution, eti: l.eti.monthlyEti, flags }).toEqual({ paye: 8_000, uif: 0, eti: 0, flags: ['directive', 'flat_psp'] });
    expect(pspTaxBasis(l.validationResults)).toMatch(/IRP3\(b\) directive/);
    expect(l.explanations!.paye.result).toBe(8_000);
  });
  it('an IRP3(c) fixed-amount directive on a PSP: G21 p. 16 issues an IRP3(b) for a PSP, so (c) is refused or warned, not silently applied', () => {
    const l = line('company', directive('fixed_amount', null, 1_000));
    const flagged = l.validationResults.some((v) => /personal service provider/i.test(v.message ?? '') && /IRP3\(c\)|fixed.amount/i.test(v.message ?? ''));
    expect({ paye: l.paye.monthlyPaye, flagged }).not.toEqual({ paye: 1_000, flagged: false });
  });
});

describe('the flat base', () => {
  it('a taxable travel allowance (3701, 80% PAYE inclusion for an employee) is a payment to a PSP in full: 27% of R50 000', () => {
    const l = line('company', {}, [{ ...comp('3701', 'earning', 10_000), payeInclusionRate: 0.8 } as EmployeeComponent]);
    expect(l.paye.monthlyPaye).toBe(13_500);
  });
});
