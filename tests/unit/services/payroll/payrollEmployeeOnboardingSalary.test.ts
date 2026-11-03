/**
 * createEmployeeWithPay, the salary's window: it starts on salary.effectiveFrom when given (on the start date
 * otherwise), never before the start date and never after the end date, and not in a paid month; each refusal is raised
 * before the first write (a 4xx commits).
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
  ...(await original<typeof import('@/modules/accounting/services/payroll/payrollOnboardingPaidMonth')>()), // salaryEndRefusal stays real
  salaryInPaidMonthRefusal: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({ createPayrollEmployee: vi.fn(async () => ({ id: 'e1' })) }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', () => ({ assignComponentToEmployee: vi.fn(async () => ({ id: 'a1' })) }));

import { salaryInPaidMonthRefusal } from '@/modules/accounting/services/payroll/payrollOnboardingPaidMonth';
import { createPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { assignComponentToEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';
import { createEmployeeWithPay, EmployeeOnboardingRefused } from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const COMPONENT = '22222222-2222-4222-8222-222222222222';
const BASE = { firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'E-1', employmentType: 'permanent', startDate: '2026-11-01' };
const salary = { componentId: COMPONENT, amountCents: 2_500_000 };
const go = (over: Record<string, unknown> = {}) => createEmployeeWithPay(COMPANY, 'u1', { ...BASE, ...over });

beforeEach(() => vi.clearAllMocks());

async function expectRefused(run: Promise<unknown>, reason: RegExp) {
  const err = await run.then(() => null, (e) => e as Error);
  expect(err).toBeInstanceOf(EmployeeOnboardingRefused);
  expect(err?.message).toMatch(reason);
  expect(createPayrollEmployee).not.toHaveBeenCalled();
  expect(assignComponentToEmployee).not.toHaveBeenCalled();
}

describe('createEmployeeWithPay: the salary window', () => {
  it('starts on salary.effectiveFrom when given, on the start date otherwise', async () => {
    await go({ salary: { ...salary, effectiveFrom: '2026-12-01' } });
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![4]).toBe('2026-12-01');
    expect(salaryInPaidMonthRefusal).toHaveBeenCalledWith(COMPANY, '2026-12-01', null, false);
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![5]).toBeUndefined();
    vi.mocked(assignComponentToEmployee).mockClear();
    await go({ salary });
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![4]).toBe('2026-11-01');
  });

  it('is refused before any write when it starts before the start date, or is not a date', async () => {
    await expectRefused(go({ salary: { ...salary, effectiveFrom: '2026-10-31' } }), /before the startDate/);
    await expectRefused(go({ salary: { ...salary, effectiveFrom: '2026-02-30' } }), /real date/);
  });

  it('is refused before any write when it starts after the end date', async () => {
    await expectRefused(go({ endDate: '2026-11-30', salary: { ...salary, effectiveFrom: '2026-12-01' } }), /cannot be after the end of the salary/);
    vi.mocked(assignComponentToEmployee).mockClear();
    await go({ endDate: '2026-11-30', salary: { ...salary, effectiveFrom: '2026-11-30' } });
    expect(assignComponentToEmployee).toHaveBeenCalledTimes(1);
  });

  it('ends with the employment: the end date closes the salary and bounds the paid-month check', async () => {
    await go({ endDate: '2026-12-31', salary });
    expect(salaryInPaidMonthRefusal).toHaveBeenCalledWith(COMPANY, '2026-11-01', '2026-12-31', true);
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![5]).toBe('2026-12-31');
  });

  it('salary.effectiveTo ends the salary before the employment does, never after', async () => {
    await go({ endDate: '2026-12-15', salary: { ...salary, effectiveTo: '2026-11-30' } });
    expect(vi.mocked(assignComponentToEmployee).mock.calls[0]![5]).toBe('2026-11-30');
    vi.mocked(assignComponentToEmployee).mockClear();
    vi.mocked(createPayrollEmployee).mockClear();
    await expectRefused(go({ endDate: '2026-12-31', salary: { ...salary, effectiveTo: '2027-01-31' } }), /effectiveTo cannot be after the endDate/);
    await expectRefused(go({ salary: { ...salary, effectiveTo: '2026-02-30' } }), /effectiveTo must be a real date/);
  });

  it('is refused before any write when the salary ends before the 27th (it pays nothing that month); the 27th is accepted', async () => {
    await expectRefused(go({ endDate: '2026-12-15', salary }), /paid nothing for December 2026.*End the salary on 2026-11-30/);
    expect(salaryInPaidMonthRefusal).not.toHaveBeenCalled();
    await go({ endDate: '2026-12-27', salary });
    expect(assignComponentToEmployee).toHaveBeenCalledTimes(1);
  });

  it('is refused before any write when it lies in a paid month, with the text the check gives', async () => {
    vi.mocked(salaryInPaidMonthRefusal).mockResolvedValueOnce('October 2026 is already paid. Set the salary to start 2026-11-01 and pay the October days as a once-off in an open month.');
    await expectRefused(go({ salary }), /^October 2026 is already paid\. Set the salary to start 2026-11-01/);
  });

  it('writes no paid-month check for an employee without a salary', async () => {
    await go();
    expect(salaryInPaidMonthRefusal).not.toHaveBeenCalled();
  });
});

