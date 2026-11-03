/**
 * The paid-month refusal and the early-end refusal give ONE message with both pieces of advice, and following it (the
 * start AND the end) creates the employee. The real salaryInPaidMonthRefusal runs, with only the paid months stubbed:
 * March 2026 is paid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ paid: [{ year: 2026, month: 3 }] as Array<{ year: number; month: number }> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (parts: TemplateStringsArray) => {
    const text = parts.join('?');
    if (text.includes('FROM payroll_components')) return [{ sars_source_code: '3601', component_type: 'earning', is_active: true, is_taxable: true }];
    if (text.includes('FROM payroll_employees')) return [];
    throw new Error(`unexpected query: ${text}`);
  }),
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('@/modules/accounting/services/payroll/payrollComponentPaidMonths', () => ({
  lockCompanyPayrollForComponentChange: vi.fn(async () => undefined),
  paidPeriodsOf: vi.fn(async () => state.paid),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({ createPayrollEmployee: vi.fn(async () => ({ id: 'e1' })) }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeComponentService', () => ({ assignComponentToEmployee: vi.fn(async () => ({ id: 'a1' })) }));

import { createPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { createEmployeeWithPay, EmployeeOnboardingRefused } from '@/modules/accounting/services/payroll/payrollEmployeeOnboarding';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const salary = { componentId: '22222222-2222-4222-8222-222222222222', amountCents: 2_500_000 };
const BASE = { firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'E-1', employmentType: 'permanent' };
const go = (over: Record<string, unknown>) => createEmployeeWithPay(COMPANY, 'u1', { ...BASE, ...over });
const DAY = String.raw`(\d{4}-\d\d-\d\d)`;

beforeEach(() => {
  vi.clearAllMocks();
  state.paid = [{ year: 2026, month: 3 }];
});

describe('following the paid-month advice, then the end advice, creates the employee', () => {
  it.each([
    ['the salary ends with the employment (15 May)', { startDate: '2026-03-05', endDate: '2026-05-15', salary }],
    ['the salary ends earlier than the employment, on the 28th (effectiveTo 28 May, endDate 30 June)',
      { startDate: '2026-03-05', endDate: '2026-06-30', salary: { ...salary, effectiveTo: '2026-05-28' } }],
  ])('%s', async (_name, body) => {
    const refusal = await go(body).then(() => null, (e) => e as Error);
    expect(refusal).toBeInstanceOf(EmployeeOnboardingRefused);
    const start = new RegExp(`Set the salary to start ${DAY}`).exec(refusal!.message)?.[1];
    expect(start, refusal!.message).toBe('2026-04-01');
    const ends = [...refusal!.message.matchAll(new RegExp(`(?:End the salary on|or on) ${DAY}`, 'g'))].map((m) => m[1]!);
    expect(ends.length, refusal!.message).toBeGreaterThan(0);
    for (const end of ends) {
      vi.mocked(createPayrollEmployee).mockClear();
      await expect(
        go({ ...body, salary: { ...salary, effectiveFrom: start, effectiveTo: end } }),
        `start ${start}, effectiveTo ${end} is accepted`,
      ).resolves.toBeDefined();
      expect(createPayrollEmployee).toHaveBeenCalledTimes(1);
    }
  });

  it('a salary that needs no end change keeps the plain start advice', async () => {
    const refusal = await go({ startDate: '2026-03-05', salary }).then(() => null, (e) => e as Error);
    expect(refusal!.message).toBe('March 2026 is already paid. Set the salary to start 2026-04-01 and pay the March days as a once-off in an open month.');
  });
});

describe('other paid months: each date the one message names is followed and accepted', () => {
  async function followed(body: Record<string, unknown>) {
    const refusal = await go(body).then(() => null, (e) => e as Error);
    expect(refusal).toBeInstanceOf(EmployeeOnboardingRefused);
    const text = refusal!.message;
    const start = new RegExp(`Set the salary to start ${DAY}`).exec(text)?.[1] ?? null;
    const ends = [...text.matchAll(new RegExp(`(?:End the salary on|or on) ${DAY}`, 'g'))].map((m) => m[1]!);
    const withEmployment = new RegExp(`with the employment on ${DAY}`).exec(text)?.[1] ?? null;
    return { text, start, ends, withEmployment };
  }

  it('February paid, the employment ends on 15 March: no salary; creating the employee without one works', async () => {
    state.paid = [{ year: 2026, month: 2 }];
    const body = { startDate: '2026-02-10', endDate: '2026-03-15', salary };
    const { text } = await followed(body);
    expect(text).toContain('pay the February and March days as once-offs');
    expect(text).toContain('create the employee without a salary');
    await expect(go({ ...body, salary: undefined })).resolves.toBeDefined();
  });

  it('February paid, the salary ends 15 March but the employment runs to June: start 1 March, end 31 March', async () => {
    state.paid = [{ year: 2026, month: 2 }];
    const body = { startDate: '2026-02-10', endDate: '2026-06-30', salary: { ...salary, effectiveTo: '2026-03-15' } };
    const { start, ends } = await followed(body);
    expect(start).toBe('2026-03-01');
    expect(ends).toEqual(['2026-03-31']);
    await expect(go({ ...body, salary: { ...salary, effectiveFrom: start, effectiveTo: ends[0] } })).resolves.toBeDefined();
  });

  it('January 2028 paid, a salary ending 28 February 2028 (a leap year): the advice is the 29th, and it is accepted', async () => {
    state.paid = [{ year: 2028, month: 1 }];
    const body = { startDate: '2028-01-10', endDate: '2028-06-30', salary: { ...salary, effectiveTo: '2028-02-28' } };
    const { start, ends } = await followed(body);
    expect(start).toBe('2028-02-01');
    expect(ends).toEqual(['2028-02-29']);
    await expect(go({ ...body, salary: { ...salary, effectiveFrom: start, effectiveTo: ends[0] } })).resolves.toBeDefined();
  });

  it('February paid, the employment ends on 28 March, the salary on 10 March: end it with the employment', async () => {
    state.paid = [{ year: 2026, month: 2 }];
    const body = { startDate: '2026-02-10', endDate: '2026-03-28', salary: { ...salary, effectiveTo: '2026-03-10' } };
    const { start, withEmployment } = await followed(body);
    expect(start).toBe('2026-03-01');
    expect(withEmployment).toBe('2026-03-28');
    await expect(go({ ...body, salary: { ...salary, effectiveFrom: start, effectiveTo: withEmployment } })).resolves.toBeDefined();
  });
});

