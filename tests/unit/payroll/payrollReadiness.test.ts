import { describe, it, expect } from 'vitest';
import { scoreEmployeeReadiness } from '@/modules/payroll/payrollReadinessService';

describe('scoreEmployeeReadiness', () => {
  // Using the known-valid SA ID from payrollValidation.test.ts
  const base = {
    id: 'emp-1',
    employee_number: 'E001',
    first_name: 'Alice',
    last_name: 'Test',
    id_number: '9202204720083',
    tax_number: '1234567890',
    bank_account_number: '12345678',
    bank_branch_code: '632005',
    payslipCount: 12,
    etiClaimed: 0,
    etiEligible: true,
  };

  it('ready employee = no blocking, no warnings', () => {
    const r = scoreEmployeeReadiness(base);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('missing tax number = blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, tax_number: null });
    expect(r.blocking.some(b => /tax number/i.test(b))).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('invalid ID = blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, id_number: '1234' });
    expect(r.blocking.some(b => /ID/i.test(b))).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('no payslips = blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, payslipCount: 0 });
    expect(r.blocking.some(b => /payslip/i.test(b))).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('missing bank = warning, not blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, bank_account_number: null });
    expect(r.warnings.some(w => /bank/i.test(w))).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('ETI claimed but not eligible = warning', () => {
    const r = scoreEmployeeReadiness({ ...base, etiClaimed: 500, etiEligible: false });
    expect(r.warnings.some(w => /ETI/.test(w))).toBe(true);
  });
});
