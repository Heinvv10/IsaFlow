import { describe, it, expect } from 'vitest';
import {
  calculateETI,
  isEtiEligible,
  monthsSinceEtiStart,
} from '@/modules/payroll/payrollEtiService';

describe('ETI monthly calculation', () => {
  it('month 1-12, wage R2,000 → ETI R1,500', () => {
    expect(calculateETI(2000, 1)).toBe(1500);
  });

  it('month 1-12, wage R1,500 → ETI R1,500 (capped)', () => {
    expect(calculateETI(1500, 1)).toBe(1500);
  });

  it('month 1-12, wage R4,250 → ETI = 0.5 × (6500-4250) = R1,125', () => {
    expect(calculateETI(4250, 6)).toBe(1125);
  });

  it('month 1-12, wage R6,500 → ETI R0', () => {
    expect(calculateETI(6500, 12)).toBe(0);
  });

  it('month 1-12, wage R7,000 → ETI R0 (above ceiling)', () => {
    expect(calculateETI(7000, 5)).toBe(0);
  });

  it('month 13-24, wage R2,000 → ETI R750 (half of first-year)', () => {
    expect(calculateETI(2000, 13)).toBe(750);
  });

  it('month 13-24, wage R4,250 → ETI = 0.25 × (6500-4250) = R562.50', () => {
    expect(calculateETI(4250, 18)).toBe(562.5);
  });

  it('month 25+ → ETI R0', () => {
    expect(calculateETI(2000, 25)).toBe(0);
  });

  it('negative months → ETI R0', () => {
    expect(calculateETI(2000, 0)).toBe(0);
    expect(calculateETI(2000, -1)).toBe(0);
  });
});

describe('ETI eligibility', () => {
  const periodEnd = new Date('2026-04-30');

  it('eligible: age 25, not connected, has start date, has valid ID', () => {
    // 0102204720083 → born 2001-02-20 → age 25 at 2026-04-30 (within 18-29 ETI window)
    const result = isEtiEligible({
      idNumber: '0102204720083',
      etiStartDate: '2025-05-01',
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(true);
  });

  it('ineligible: age > 29', () => {
    // 1985 DOB → age ~40 at 2026-04-30. Any 13-digit string starting '85' works
    // for age extraction — the existing calculateAgeFromIdNumber doesn't Luhn-check.
    const result = isEtiEligible({
      idNumber: '8502204720088',
      etiStartDate: '2025-05-01',
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/age/i);
  });

  it('ineligible: connected person', () => {
    const result = isEtiEligible({
      idNumber: '0102204720083',
      etiStartDate: '2025-05-01',
      isConnectedPerson: true,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toMatch(/connected/i);
  });

  it('ineligible: no ETI start date', () => {
    const result = isEtiEligible({
      idNumber: '0102204720083',
      etiStartDate: null,
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
  });

  it('ineligible: missing ID number', () => {
    const result = isEtiEligible({
      idNumber: null,
      etiStartDate: '2025-05-01',
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
  });
});

describe('monthsSinceEtiStart', () => {
  it('same month = 1', () => {
    expect(monthsSinceEtiStart('2026-04-01', new Date('2026-04-30'))).toBe(1);
  });

  it('one year later = 13', () => {
    expect(monthsSinceEtiStart('2025-04-01', new Date('2026-04-30'))).toBe(13);
  });

  it('25th month returns 25', () => {
    expect(monthsSinceEtiStart('2024-04-01', new Date('2026-04-30'))).toBe(25);
  });
});
