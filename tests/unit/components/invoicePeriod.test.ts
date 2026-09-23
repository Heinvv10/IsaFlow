import { describe, it, expect } from 'vitest';
import { monthRange, wholeMonthOf, currentMonth } from '@/components/accounting/invoicePeriod';

describe('monthRange', () => {
  it('covers the whole month, inclusive', () => {
    expect(monthRange('2026-06')).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('knows February in leap and common years', () => {
    expect(monthRange('2028-02')?.to).toBe('2028-02-29');
    expect(monthRange('2026-02')?.to).toBe('2026-02-28');
  });

  it('rejects anything that is not YYYY-MM', () => {
    expect(monthRange('2026-13')).toBeNull();
    expect(monthRange('2026-6')).toBeNull();
    expect(monthRange('debtors')).toBeNull();
  });
});

describe('wholeMonthOf', () => {
  it('recognises an exact month range', () => {
    expect(wholeMonthOf('2026-06-01', '2026-06-30')).toBe('2026-06');
  });

  it('is null for a partial or multi-month range', () => {
    expect(wholeMonthOf('2026-06-01', '2026-06-29')).toBeNull();
    expect(wholeMonthOf('2026-06-02', '2026-06-30')).toBeNull();
    expect(wholeMonthOf('2026-06-01', '2026-07-31')).toBeNull();
    expect(wholeMonthOf('', '')).toBeNull();
  });
});

describe('currentMonth', () => {
  it('uses the local calendar, not UTC', () => {
    // 00:30 local on 1 July is still 30 June in UTC for a UTC+2 box.
    expect(currentMonth(new Date(2026, 6, 1, 0, 30))).toBe('2026-07');
  });
});
