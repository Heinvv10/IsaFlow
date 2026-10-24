import { describe, it, expect } from 'vitest';
import {
  payeTaxPeriodNumber,
  payeTaxYearBounds,
  payeTaxYearPeriods,
  payeTaxYearOf,
} from '@/modules/accounting/utils/payeTaxYear';

describe('payeTaxYearOf', () => {
  it('March starts the tax year that ends the next February', () => {
    expect(payeTaxYearOf(3, 2026)).toBe(2027);
    expect(payeTaxYearOf(12, 2026)).toBe(2027);
  });
  it('January and February belong to the tax year ending that February', () => {
    expect(payeTaxYearOf(1, 2027)).toBe(2027);
    expect(payeTaxYearOf(2, 2027)).toBe(2027);
  });
});

describe('payeTaxPeriodNumber', () => {
  it('numbers March 1 to February 12 and never takes a company start month', () => {
    expect([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2].map(payeTaxPeriodNumber))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('payeTaxYearBounds', () => {
  it('runs 1 March to 28 February in a common year', () => {
    expect(payeTaxYearBounds(2027)).toEqual({ start: '2026-03-01', end: '2027-02-28' });
  });
  it('ends on 29 February in a leap year', () => {
    expect(payeTaxYearBounds(2028)).toEqual({ start: '2027-03-01', end: '2028-02-29' });
  });
  it('treats 2100 (divisible by 100, not 400) as common and 2000 as leap', () => {
    expect(payeTaxYearBounds(2100).end).toBe('2100-02-28');
    expect(payeTaxYearBounds(2000).end).toBe('2000-02-29');
  });
});

describe('payeTaxYearPeriods', () => {
  it('is the year/month bounds of the payroll periods in the tax year (March of the year before to February)', () => {
    expect(payeTaxYearPeriods(2027)).toEqual({ startYear: 2026, startMonth: 3, endYear: 2027, endMonth: 2 });
    expect(payeTaxYearPeriods(2028)).toEqual({ startYear: 2027, startMonth: 3, endYear: 2028, endMonth: 2 });
  });
});
