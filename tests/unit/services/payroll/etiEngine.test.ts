import { describe, it, expect } from 'vitest';
import { calculateEti } from '@/modules/accounting/services/payroll/etiEngine';
import { selectEtiTable } from '@/modules/accounting/services/payroll/etiTables';

/** Last pay run under the 1 Mar 2022 formula, and the first two under the 1 Apr 2025 one. */
const OLD_PERIOD = new Date(2025, 2, 28);
const NEW_PERIOD = new Date(2025, 3, 28);
const LATER_PERIOD = new Date(2026, 5, 28);

function dob(periodDate: Date, yearsAgo: number): Date {
  return new Date(periodDate.getFullYear() - yearsAgo, periodDate.getMonth(), 1);
}

function monthsAgo(periodDate: Date, months: number): Date {
  return new Date(periodDate.getFullYear(), periodDate.getMonth() - months, 1);
}

/** Eligible employee: aged 25, in employment month `monthsEmployed` (1-based). */
function eti(periodDate: Date, remuneration: number, monthsEmployed = 3) {
  return calculateEti({
    dateOfBirth: dob(periodDate, 25),
    employmentStartDate: monthsAgo(periodDate, monthsEmployed - 1),
    periodDate,
    monthlyRemuneration: remuneration,
    isUifExcluded: false,
  }, 2026);
}

describe('ETI engine - eligibility', () => {
  const at = (age: number) => calculateEti({
    dateOfBirth: dob(NEW_PERIOD, age),
    employmentStartDate: monthsAgo(NEW_PERIOD, 2),
    periodDate: NEW_PERIOD,
    monthlyRemuneration: 4_000,
    isUifExcluded: false,
  }, 2026);

  it('age 29 is the oldest qualifying age', () => {
    expect(at(29).isEligible).toBe(true);
    expect(at(29).monthlyEti).toBe(1_500);
  });

  it('age 30 is ineligible (ETI Act s6(a): 18-29)', () => {
    const r = at(30);
    expect(r.isEligible).toBe(false);
    expect(r.ineligibilityReason).toBe('Employee age must be 18–29');
    expect(r.monthlyEti).toBe(0);
  });

  it('age 35 is ineligible', () => {
    expect(at(35).isEligible).toBe(false);
    expect(at(35).monthlyEti).toBe(0);
  });

  it('age 18 qualifies and age 17 does not', () => {
    expect(at(18).isEligible).toBe(true);
    expect(at(17).isEligible).toBe(false);
  });

  it('UIF excluded employee is ineligible', () => {
    const r = calculateEti({
      dateOfBirth: dob(NEW_PERIOD, 25),
      employmentStartDate: monthsAgo(NEW_PERIOD, 2),
      periodDate: NEW_PERIOD,
      monthlyRemuneration: 3_000,
      isUifExcluded: true,
    }, 2026);
    expect(r.isEligible).toBe(false);
    expect(r.ineligibilityReason).toContain('UIF');
  });

  it('wage above the ceiling is ineligible', () => {
    const r = eti(NEW_PERIOD, 8_000);
    expect(r.isEligible).toBe(false);
    expect(r.ineligibilityReason).toContain('wage');
  });

  it('the old ceiling (R6 500) applies to a pre-April 2025 period', () => {
    expect(eti(OLD_PERIOD, 6_501).isEligible).toBe(false);
    expect(eti(NEW_PERIOD, 6_501).isEligible).toBe(true);
  });

  it('month 25 of employment is outside the 24-month window', () => {
    const r = eti(NEW_PERIOD, 3_000, 25);
    expect(r.isEligible).toBe(false);
    expect(r.employmentYear).toBeNull();
  });
});

describe('ETI engine - formula from 1 April 2025, first 12 months', () => {
  it.each([
    [0, 0],
    [1_000, 600],                  // 60% x 1 000
    [2_499.99, 1_499.99],          // 60% x 2 499.99 = 1 499.994
    [2_500, 1_500],
    [4_000, 1_500],
    [5_499.99, 1_500],
    [5_500, 1_500],                // 1 500 - 75% x 0
    [6_500, 750],                  // 1 500 - 75% x 1 000
    [7_000, 375],                  // 1 500 - 75% x 1 500
    [7_499.99, 0.01],              // 1 500 - 75% x 1 999.99 = 0.0075
    [7_500, 0],
  ])('R%d a month gives R%d', (remuneration, expected) => {
    expect(eti(NEW_PERIOD, remuneration).monthlyEti).toBeCloseTo(expected, 2);
  });
});

describe('ETI engine - formula from 1 April 2025, months 13-24 (half)', () => {
  it.each([
    [1_000, 300],                  // 30% x 1 000
    [2_499.99, 750],               // 30% x 2 499.99 = 749.997
    [2_500, 750],
    [5_500, 750],
    [6_500, 375],                  // 750 - 37.5% x 1 000
    [7_000, 187.5],                // 750 - 37.5% x 1 500
    [7_500, 0],
  ])('R%d a month gives R%d', (remuneration, expected) => {
    const r = eti(NEW_PERIOD, remuneration, 15);
    expect(r.employmentYear).toBe(2);
    expect(r.monthlyEti).toBeCloseTo(expected, 2);
  });
});

describe('ETI engine - formula 1 March 2022 to 31 March 2025, first 12 months', () => {
  it.each([
    [1_000, 750],                  // 75% x 1 000
    [1_999.99, 1_499.99],          // 75% x 1 999.99 = 1 499.9925
    [2_000, 1_500],
    [4_499.99, 1_500],
    [4_500, 1_500],                // 1 500 - 75% x 0
    [5_500, 750],                  // 1 500 - 75% x 1 000
    [6_499.99, 0.01],              // 1 500 - 75% x 1 999.99 = 0.0075
    [6_500, 0],
  ])('R%d a month gives R%d', (remuneration, expected) => {
    expect(eti(OLD_PERIOD, remuneration).monthlyEti).toBeCloseTo(expected, 2);
  });
});

describe('ETI engine - formula 1 March 2022 to 31 March 2025, months 13-24 (half)', () => {
  it.each([
    [1_000, 375],                  // 37.5% x 1 000
    [2_000, 750],
    [5_500, 375],                  // 750 - 37.5% x 1 000
    [6_500, 0],
  ])('R%d a month gives R%d', (remuneration, expected) => {
    const r = eti(OLD_PERIOD, remuneration, 15);
    expect(r.employmentYear).toBe(2);
    expect(r.monthlyEti).toBeCloseTo(expected, 2);
  });
});

describe('ETI engine - the formula is chosen by the pay period', () => {
  it('March 2025 uses the old table and April 2025 the new one', () => {
    expect(eti(OLD_PERIOD, 2_200).monthlyEti).toBe(1_500);     // flat band from R2 000
    expect(eti(NEW_PERIOD, 2_200).monthlyEti).toBe(1_320);     // 60% x 2 200
    expect(eti(OLD_PERIOD, 6_000).monthlyEti).toBe(375);       // 1 500 - 75% x 1 500
    expect(eti(NEW_PERIOD, 6_000).monthlyEti).toBe(1_125);     // 1 500 - 75% x 500
  });

  it('periods after March 2026 stay on the April 2025 table (unconfirmed assumption)', () => {
    expect(eti(LATER_PERIOD, 2_200).monthlyEti).toBe(1_320);
    expect(selectEtiTable(LATER_PERIOD)).toBe(selectEtiTable(NEW_PERIOD));
  });

  it('refuses a period before the March 2022 formula existed', () => {
    expect(() => selectEtiTable(new Date(2022, 1, 28))).toThrow(/before March 2022/);
  });
});
