import { describe, it, expect } from 'vitest';

import {
  computeExpectedAccrual,
  computeCarryOver,
  endOfMonthIso,
  round2,
} from '@/modules/accounting/services/payroll/leaveAccrualService';

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.2345)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
  });
});

describe('endOfMonthIso', () => {
  it('returns the last UTC day of the month', () => {
    expect(endOfMonthIso(2026, 1)).toBe('2026-01-31');
    expect(endOfMonthIso(2026, 2)).toBe('2026-02-28');
    expect(endOfMonthIso(2024, 2)).toBe('2024-02-29'); // leap year
  });
});

describe('computeExpectedAccrual — monthly rule', () => {
  it('returns zero before the effective start', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2026-06-01',
      asOf: '2026-03-31',
      yearStart: '2026-01-01',
      accrualRule: 'monthly',
      accrualDays: 1.25,
    });
    expect(days).toBe(0);
  });

  it('accrues 12 × 1.25 = 15 days over a full calendar year', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2025-01-01',
      asOf: '2026-12-31',
      yearStart: '2026-01-01',
      accrualRule: 'monthly',
      accrualDays: 1.25,
    });
    // from yearStart 2026-01-01 to asOf 2026-12-31 = ~12 months
    expect(days).toBeCloseTo(15, 0);
  });

  it('pro-rates for mid-month start within the year', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2026-03-16',
      asOf: '2026-03-31',
      yearStart: '2026-01-01',
      accrualRule: 'monthly',
      accrualDays: 1.25,
    });
    // ~15 days / 30 = 0.5 months × 1.25 = 0.625 — round2 → 0.63
    expect(days).toBeGreaterThan(0.4);
    expect(days).toBeLessThan(0.7);
  });

  it('stops accruing at employee end date', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2026-01-01',
      employeeEnd: '2026-06-30',
      asOf: '2026-12-31',
      yearStart: '2026-01-01',
      accrualRule: 'monthly',
      accrualDays: 1.25,
    });
    // ~6 months × 1.25 = 7.5
    expect(days).toBeCloseTo(7.5, 0);
  });

  it('uses the later of employee start / year start', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2026-07-01',
      asOf: '2026-12-31',
      yearStart: '2026-01-01',
      accrualRule: 'monthly',
      accrualDays: 1.25,
    });
    // ~6 months × 1.25 = 7.5
    expect(days).toBeCloseTo(7.5, 0);
  });
});

describe('computeExpectedAccrual — cycle_30_per_36 (sick)', () => {
  it('accrues 30/36 × months', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2026-01-01',
      asOf: '2026-12-31',
      yearStart: '2026-01-01',
      accrualRule: 'cycle_30_per_36',
      accrualDays: 0,
    });
    // 12 × 30/36 = 10
    expect(days).toBeCloseTo(10, 0);
  });
});

describe('computeExpectedAccrual — none', () => {
  it('always returns 0', () => {
    const days = computeExpectedAccrual({
      employeeStart: '2020-01-01',
      asOf: '2026-12-31',
      yearStart: '2026-01-01',
      accrualRule: 'none',
      accrualDays: 5,
    });
    expect(days).toBe(0);
  });
});

describe('computeCarryOver', () => {
  it('treats negative balances as zero', () => {
    expect(computeCarryOver(-2, 10)).toBe(0);
  });

  it('caps at maxCarryOver when provided', () => {
    expect(computeCarryOver(12, 5)).toBe(5);
  });

  it('preserves balance under the cap', () => {
    expect(computeCarryOver(3, 5)).toBe(3);
  });

  it('unlimited carry when maxCarryOver is null', () => {
    expect(computeCarryOver(99.5, null)).toBe(99.5);
  });

  it('treats max of 0 as "no carry"', () => {
    expect(computeCarryOver(10, 0)).toBe(0);
  });
});
