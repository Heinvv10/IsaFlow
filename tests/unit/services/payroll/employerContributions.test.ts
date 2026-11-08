/**
 * Employer medical contribution, code 3810 (wave 5 FB). PAYE-GEN-01-G21 (2027) Rev 1 p. 11-12: a contribution made
 * by the employer on behalf of the employee is a taxable fringe benefit deemed paid by the employee; the same value
 * (code 3810) is added to the contributions the employee made (code 4005) for the medical scheme fees tax credit.
 * Seventh Schedule para 12A; s6A / s6B.
 */
import { describe, expect, it } from 'vitest';
import {
  deemedMedicalFees,
  isEmployerMedicalFringeCode,
  markNonCashEmployerBenefits,
} from '@/modules/accounting/services/payroll/employerContributions';
import type { EmployeeComponent, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, type: PayrollComponent['componentType'] = 'earning'): PayrollComponent => ({
  id: `c-${code}`, name: code, sarsSourceCode: code, componentType: type,
  isTaxable: true, isUifApplicable: false, isSdlApplicable: false,
});

describe('3810', () => {
  it('is recognised after the calculator trim', () => {
    expect(isEmployerMedicalFringeCode('3810')).toBe(true);
    expect(isEmployerMedicalFringeCode(' 3810\n')).toBe(true);
    expect(isEmployerMedicalFringeCode('3801')).toBe(false);
  });
  it('markNonCashEmployerBenefits flags only a 3810 earning', () => {
    const input: EmployeeComponent[] = [
      { component: comp('3601'), amount: 25000 },
      { component: comp('3810'), amount: 3000 },
      { component: comp('3810', 'deduction'), amount: 10 },
    ];
    const out = markNonCashEmployerBenefits(input);
    expect(out[0]).not.toHaveProperty('isNonCash');
    expect(out[1]?.isNonCash).toBe(true);
    expect(out[2]).not.toHaveProperty('isNonCash');
    expect(input[1]).not.toHaveProperty('isNonCash');
  });
  it('deemedMedicalFees sums only 3810 earnings: the value deemed paid by the employee (G21 p. 12)', () => {
    expect(deemedMedicalFees([
      { component: comp('3601'), amount: 25000 },
      { component: comp('3810'), amount: 3000 },
      { component: comp('3810'), amount: 500.5 },
    ])).toBe(3500.5);
  });
});
