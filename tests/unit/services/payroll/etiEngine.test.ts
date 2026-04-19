import { describe, it, expect } from 'vitest';
import { calculateEti } from '@/modules/accounting/services/payroll/etiEngine';

const periodDate = new Date('2025-03-31');

function dob(yearsAgo: number): Date {
  const d = new Date(periodDate);
  d.setFullYear(d.getFullYear() - yearsAgo);
  return d;
}

function startDate(monthsAgo: number): Date {
  const d = new Date(periodDate);
  d.setMonth(d.getMonth() - monthsAgo);
  return d;
}

describe('ETI engine — eligibility', () => {
  it('age 36 → ineligible (too old)', () => {
    const result = calculateEti({
      dateOfBirth: dob(36),
      employmentStartDate: startDate(3),
      periodDate,
      monthlyRemuneration: 4_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.ineligibilityReason).toContain('age');
    expect(result.monthlyEti).toBe(0);
  });

  it('age 17 → ineligible (too young)', () => {
    const result = calculateEti({
      dateOfBirth: dob(17),
      employmentStartDate: startDate(2),
      periodDate,
      monthlyRemuneration: 3_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
  });

  it('UIF excluded employee → ineligible', () => {
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(2),
      periodDate,
      monthlyRemuneration: 3_000,
      isUifExcluded: true,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.ineligibilityReason).toContain('UIF');
  });

  it('wage above R7,500 → ineligible', () => {
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(3),
      periodDate,
      monthlyRemuneration: 8_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.ineligibilityReason).toContain('wage');
  });
});

describe('ETI engine — year 1 calculations', () => {
  it('wage ≤ R4,500 in year 1 → R1,500', () => {
    const result = calculateEti({
      dateOfBirth: dob(22),
      employmentStartDate: startDate(3),
      periodDate,
      monthlyRemuneration: 3_500,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.employmentYear).toBe(1);
    expect(result.monthlyEti).toBeCloseTo(1_500, 2);
  });

  it('wage R6,000 in year 1 → R750 (linear taper)', () => {
    // 1500 × (7500 - 6000) / 3000 = 750
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(8),
      periodDate,
      monthlyRemuneration: 6_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.monthlyEti).toBeCloseTo(750, 2);
  });

  it('wage exactly R7,500 in year 1 → R0 (at ceiling)', () => {
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(6),
      periodDate,
      monthlyRemuneration: 7_500,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.monthlyEti).toBeCloseTo(0, 2);
  });
});

describe('ETI engine — year 2 calculations', () => {
  it('wage ≤ R4,500 in year 2 → R750', () => {
    const result = calculateEti({
      dateOfBirth: dob(22),
      employmentStartDate: startDate(15),
      periodDate,
      monthlyRemuneration: 4_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.employmentYear).toBe(2);
    expect(result.monthlyEti).toBeCloseTo(750, 2);
  });

  it('month 25 → ineligible (ETI window expired)', () => {
    const result = calculateEti({
      dateOfBirth: dob(22),
      employmentStartDate: startDate(25),
      periodDate,
      monthlyRemuneration: 3_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.employmentYear).toBeNull();
  });
});
