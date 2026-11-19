/**
 * Adversarial repros for PR #1566 (PSP). Each test states what SHOULD hold; a red test is a confirmed defect.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';
import { buildCaseInput, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

function line(entity: 'company' | 'trust', extra: EmployeeComponent[] = []) {
  const c: OracleCase = {
    id: `adv-${entity}`, source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: 2026, month: 6 }, taxYear: 2027,
      employee: {
        dateOfBirth: '1990-01-01', startDate: '2020-03-01', taxStatus: `personal_service_${entity}`, uifExcluded: false,
        medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
      },
      employerAnnualRemuneration: 2_000_000,
      components: [{ code: '3601', name: 'Fees', type: 'earning', amount: 40_000, taxable: true, uif: true, sdl: true }],
    },
    expected: {},
  };
  const input: PayrollLineInput = buildCaseInput(c);
  return calculatePayrollLine({ ...input, components: [...input.components, ...extra] });
}

const comp = (code: string, type: 'earning' | 'deduction', amount: number, more: Partial<EmployeeComponent> = {}): EmployeeComponent => ({
  component: { id: `c-${code}`, name: code, sarsSourceCode: code, componentType: type, isTaxable: true, isUifApplicable: false, isSdlApplicable: true },
  amount, ...more,
});

describe('PSP base: what the flat rate is applied to', () => {
  it('a retirement fund contribution (4001, s11F / para 2(4)) does not shrink a PSP company\'s PAYE base: a company is no fund member', () => {
    const plain = line('company');
    const withRa = line('company', [comp('4001', 'deduction', 10_000)]);
    // 27% x R40 000 = R10 800 either way, or the line refuses/warns. Today the base drops by the deduction.
    expect(withRa.paye.monthlyPaye).toBe(plain.paye.monthlyPaye);
  });

  it('a non-cash fringe benefit (Seventh Schedule: "employee" means a person other than a company) is not taxed on a PSP company', () => {
    const plain = line('company');
    const withFringe = line('company', [comp('3802', 'earning', 10_000, { isNonCash: true })]);
    expect(withFringe.paye.monthlyPaye).toBe(plain.paye.monthlyPaye);
  });

  it('any of the above at least raises a warning on the PSP line', () => {
    const l = line('company', [comp('4001', 'deduction', 10_000), comp('3802', 'earning', 10_000, { isNonCash: true })]);
    expect(l.validationResults.some((v) => /personal service provider/i.test(v.message ?? '') && /retirement|fringe|benefit/i.test(v.message ?? ''))).toBe(true);
  });
});

import { payeUnderTreatment } from '@/modules/accounting/services/payroll/taxStatusTreatment';
describe('PSP PAYE recomputes to the cent (half-up)', () => {
  it('45% x R10 001.90 = R4 500.855 -> R4 500.86', () => {
    expect(payeUnderTreatment('flat_psp', { regular: 0, annualPayment: 0 }, 10_001.9, 0.45).regular).toBe(4_500.86);
  });
});
