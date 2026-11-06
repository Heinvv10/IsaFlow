/** Wave 4 B: "Ready to pay" is a pure verdict over the tax number, the pay and the bank details. */
import { describe, it, expect } from 'vitest';
import { employeeReadiness, readinessSummary, type ReadinessAssignment } from '@/components/payroll/employeeReadiness';

const TODAY = '2026-11-06';
const salary = (over: Partial<ReadinessAssignment> = {}): ReadinessAssignment => ({
  componentType: 'earning', isTaxable: true, isRecurring: true, componentActive: true,
  effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: null, ...over,
});
const base = { employee: { taxNumber: '0123456789', paymentMethod: 'eft' }, components: [salary()], bank: 'on-file' as const, today: TODAY };
const keys = (r: ReturnType<typeof employeeReadiness>) => r.missing.map(m => m.key);

describe('employeeReadiness', () => {
  it('is ready with a valid tax number, a running salary and bank details', () => {
    expect(employeeReadiness(base)).toEqual({ ready: true, missing: [] });
  });

  it.each([['blank', ''], ['short', '12345'], ['bad lead digit', '5123456789'], ['absent', undefined]])('a %s tax number is missing', (_n, taxNumber) => {
    expect(keys(employeeReadiness({ ...base, employee: { ...base.employee, taxNumber } }))).toEqual(['tax']);
  });

  it('no components means no salary', () => {
    expect(keys(employeeReadiness({ ...base, components: [] }))).toEqual(['pay']);
  });

  it.each([
    ['a deduction', { componentType: 'deduction' }],
    ['a non-taxable earning', { isTaxable: false }],
    ['a once-off earning', { isRecurring: false }],
    ['a switched-off component', { componentActive: false }],
    ['one that ended last month', { effectiveTo: '2026-10-31' }],
    ['one that starts next month', { effectiveFrom: '2026-12-01' }],
  ])('%s is not a salary', (_n, over) => {
    expect(keys(employeeReadiness({ ...base, components: [salary(over as Partial<ReadinessAssignment>)] }))).toEqual(['pay']);
  });

  it('an earning that ends on the last day of the month, or starts on it, still covers the month', () => {
    expect(employeeReadiness({ ...base, components: [salary({ effectiveTo: '2026-11-01' })] }).ready).toBe(true);
    expect(employeeReadiness({ ...base, components: [salary({ effectiveFrom: '2026-11-30' })] }).ready).toBe(true);
  });

  it('EFT without bank details is missing; unknown (not loaded) is not claimed missing', () => {
    expect(keys(employeeReadiness({ ...base, bank: 'none' }))).toEqual(['bank']);
    expect(employeeReadiness({ ...base, bank: 'unknown' }).ready).toBe(true);
  });

  it('cash without bank details is ready', () => {
    expect(employeeReadiness({ ...base, employee: { ...base.employee, paymentMethod: 'cash' }, bank: 'none' }).ready).toBe(true);
  });

  it('lists everything missing, each with a link to its field', () => {
    const r = employeeReadiness({ ...base, employee: { taxNumber: '' }, components: [], bank: 'none' });
    expect(r.ready).toBe(false);
    expect(r.missing.map(m => m.href)).toEqual(['#employee-tax-number', '#employee-pay', '#employee-bank']);
  });
});

describe('readinessSummary', () => {
  it('reads "Ready to pay" or counts what is missing', () => {
    expect(readinessSummary(employeeReadiness(base))).toBe('Ready to pay');
    expect(readinessSummary(employeeReadiness({ ...base, bank: 'none' }))).toBe('1 thing before the first pay run: bank details');
    expect(readinessSummary(employeeReadiness({ ...base, employee: { taxNumber: '' }, components: [] })))
      .toBe('2 things before the first pay run: a valid tax number, a salary');
  });
});
