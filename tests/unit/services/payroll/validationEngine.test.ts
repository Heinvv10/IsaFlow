import { describe, it, expect } from 'vitest';
import { validateEmployee, validatePayrollLine } from '@/modules/accounting/services/payroll/validationEngine';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

function baseEmployee(): PayrollEmployee {
  return {
    id: 'emp-1',
    companyId: 'co-1',
    employeeNumber: 'E001',
    firstName: 'Test',
    lastName: 'Employee',
    idNumber: '9001015009087',
    taxNumber: '1234567890',
    employmentType: 'permanent',
    startDate: new Date('2020-01-01'),
    uifExcluded: false,
    medicalAidMainMember: true,
    medicalAidDependantsCount: 0,
  };
}

describe('validateEmployee', () => {
  it('passes for a complete, valid employee', () => {
    const results = validateEmployee(baseEmployee(), []);
    const errors = results.filter(r => r.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('error: missing tax number', () => {
    const emp = { ...baseEmployee(), taxNumber: undefined };
    const results = validateEmployee(emp, []);
    expect(results.some(r => r.code === 'MISSING_TAX_NUMBER' && r.severity === 'error')).toBe(true);
  });

  it('error: tax number wrong length (not 10 digits)', () => {
    const emp = { ...baseEmployee(), taxNumber: '12345' };
    const results = validateEmployee(emp, []);
    expect(results.some(r => r.code === 'INVALID_TAX_NUMBER_FORMAT' && r.severity === 'error')).toBe(true);
  });

  it('error: SA ID number wrong length', () => {
    const emp = { ...baseEmployee(), idNumber: '123' };
    const results = validateEmployee(emp, []);
    expect(results.some(r => r.code === 'INVALID_ID_NUMBER' && r.severity === 'error')).toBe(true);
  });

  it('error: duplicate tax number detected', () => {
    const emp = baseEmployee();
    const results = validateEmployee(emp, ['1234567890']);
    expect(results.some(r => r.code === 'DUPLICATE_TAX_NUMBER' && r.severity === 'error')).toBe(true);
  });

  it('warning: no bank details', () => {
    const results = validateEmployee(baseEmployee(), [], { hasBankDetails: false });
    expect(results.some(r => r.code === 'MISSING_BANK_DETAILS' && r.severity === 'warning')).toBe(true);
  });

  it('no warning when bank details present', () => {
    const results = validateEmployee(baseEmployee(), [], { hasBankDetails: true });
    expect(results.some(r => r.code === 'MISSING_BANK_DETAILS')).toBe(false);
  });

  it('each error includes a deepLink to the employee', () => {
    const emp = { ...baseEmployee(), taxNumber: undefined };
    const results = validateEmployee(emp, []);
    const taxError = results.find(r => r.code === 'MISSING_TAX_NUMBER');
    expect(taxError?.deepLink).toContain('emp-1');
  });
});

describe('validatePayrollLine', () => {
  it('warning: zero PAYE on taxable income above monthly threshold (R95,750/12)', () => {
    const results = validatePayrollLine({ taxableIncome: 15_000, monthlyPaye: 0, grossPay: 15_000 });
    expect(results.some(r => r.code === 'PAYE_ZERO_ON_TAXABLE_INCOME' && r.severity === 'warning')).toBe(true);
  });

  it('no warning when income is below monthly threshold', () => {
    const results = validatePayrollLine({ taxableIncome: 7_000, monthlyPaye: 0, grossPay: 7_000 });
    expect(results.some(r => r.code === 'PAYE_ZERO_ON_TAXABLE_INCOME')).toBe(false);
  });

  it('no warning when PAYE is positive', () => {
    const results = validatePayrollLine({ taxableIncome: 15_000, monthlyPaye: 500, grossPay: 15_000 });
    expect(results.some(r => r.code === 'PAYE_ZERO_ON_TAXABLE_INCOME')).toBe(false);
  });
});
