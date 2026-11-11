/**
 * The priced work terms (status, basis, hours, rates, employment type) are owner/admin only on create and on PATCH (a pure move out of
 * payrollEmployeeOnboarding.test.ts, which passed 300 lines).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (text.includes('FROM payroll_components')) return [{ sars_source_code: '3601', component_type: 'earning', is_active: true, is_taxable: true }];
    if (text.includes('FROM payroll_employees')) return [];
    throw new Error(`unexpected query: ${text}`);
  }),
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/payroll/payrollOnboardingPaidMonth', async (original) => ({
  ...(await original<typeof import('@/modules/accounting/services/payroll/payrollOnboardingPaidMonth')>()),
  salaryInPaidMonthRefusal: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  createPayrollEmployee: vi.fn(async () => ({ id: 'e1' })),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', () => ({
  assignComponentToEmployee: vi.fn(async () => ({ id: 'a1' })),
}));

import { createPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { createEmployeeWithPay, employeeChangesOf, EmployeeOnboardingRefused, EmployeeTermsForbidden } from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BASE = { firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'E-1', employmentType: 'permanent', startDate: '2026-11-01' };

beforeEach(() => vi.clearAllMocks());

describe('work terms: the priced ones (status, basis, hours, rates) are owner/admin only', () => {
  const asManager = (over: Record<string, unknown>) => createEmployeeWithPay(COMPANY, 'u1', { ...BASE, ...over }, false);

  it('a manager creating a director, hourly or contractor employee is forbidden before any write', async () => {
    for (const over of [{ taxStatus: 'director' }, { payBasis: 'hourly', hourlyRate: 100 }, { taxStatus: 'independent_contractor' }, { payBasis: 'daily', dailyRate: 800 }, { hoursPerWeek: 14 }, { hoursPerDay: 4 }]) {
      const err = await asManager(over).then(() => null, e => e as Error);
      expect(err).toBeInstanceOf(EmployeeTermsForbidden);
    }
    expect(createPayrollEmployee).not.toHaveBeenCalled();
  });

  it('a manager may create with the defaults the form always sends, plus an occupation', async () => {
    await asManager({ taxStatus: 'employee', payBasis: 'monthly', occupation: 'Clerk' });
    expect(createPayrollEmployee).toHaveBeenCalledTimes(1);
  });

  it('an owner may set them', async () => {
    await createEmployeeWithPay(COMPANY, 'u1', { ...BASE, taxStatus: 'director' }, true);
    expect(vi.mocked(createPayrollEmployee).mock.calls[0]![1]).toMatchObject({ taxStatus: 'director' });
  });

  it('PATCH: a manager moving a rate or status is forbidden, an occupation or unchanged value is not', () => {
    const current = { startDate: new Date('2020-01-01'), taxStatus: 'employee' as const, payBasis: 'monthly' as const };
    expect(() => employeeChangesOf({ taxStatus: 'director' }, current)).toThrow(EmployeeTermsForbidden);
    expect(() => employeeChangesOf({ hourlyRate: 90 }, current)).toThrow(EmployeeTermsForbidden);
    // Hours classify the employment (G21 p. 28), so a lower role may not move them either.
    expect(() => employeeChangesOf({ hoursPerWeek: 10 }, current)).toThrow(EmployeeTermsForbidden);
    expect(() => employeeChangesOf({ hoursPerDay: 3 }, current)).toThrow(EmployeeTermsForbidden);
    expect(employeeChangesOf({ hoursPerWeek: 10 }, current, true).hoursPerWeek).toBe(10);
    expect(employeeChangesOf({ occupation: 'Clerk', taxStatus: 'employee' }, current).occupation).toBe('Clerk');
    expect(employeeChangesOf({ taxStatus: 'director' }, current, true).taxStatus).toBe('director');
  });

  it('PATCH: the employment type is priced too: a manager may resend the stored one (never written back) but not move it', () => {
    const current = { startDate: new Date('2020-01-01'), employmentType: 'permanent' as const, taxStatus: 'employee' as const, payBasis: 'monthly' as const };
    expect(() => employeeChangesOf({ employmentType: 'casual' }, current)).toThrow(EmployeeTermsForbidden);
    expect(() => employeeChangesOf({ employmentType: 'director' }, current)).toThrow(EmployeeTermsForbidden);
    expect(employeeChangesOf({ employmentType: 'permanent', occupation: 'Clerk' }, current)).not.toHaveProperty('employmentType');
    expect(employeeChangesOf({ employmentType: 'casual' }, current, true).employmentType).toBe('casual');
  });

  it('PATCH: a manager sending priced terms equal to the stored ones writes none of them (no stale write-back)', () => {
    const current = { startDate: new Date('2020-01-01'), taxStatus: 'director' as const, payBasis: 'hourly' as const, hourlyRate: 120 };
    const out = employeeChangesOf({ taxStatus: 'director', payBasis: 'hourly', hourlyRate: 120, dailyRate: null, occupation: 'Clerk' }, current);
    for (const k of ['taxStatus', 'payBasis', 'hourlyRate', 'dailyRate']) expect(out, k).not.toHaveProperty(k);
    expect(out.occupation).toBe('Clerk');
    expect(employeeChangesOf({ taxStatus: 'director' }, current, true)).toHaveProperty('taxStatus', 'director');
  });

  it('PATCH judges a rate against the stored basis (hourly cannot lose its rate)', () => {
    const hourly = { startDate: new Date('2020-01-01'), taxStatus: 'employee' as const, payBasis: 'hourly' as const, hourlyRate: 120 };
    expect(() => employeeChangesOf({ hourlyRate: null }, hourly, true)).toThrow(EmployeeOnboardingRefused);
  });
});
