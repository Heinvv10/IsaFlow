/**
 * TDD: Leave Management & Advanced Payroll Tests
 * RED phase — written before implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateLeaveAccrual,
  calculateLeaveBalance,
  validateLeaveApplication,
  calculateTerminationPayout,
  calculateOvertimePay,
  BCEA_LEAVE_ENTITLEMENTS,
  type LeaveApplicationInput,
  type TerminationInput,
  type OvertimeInput,
} from '@/modules/accounting/services/leaveService';

// ═══════════════════════════════════════════════════════════════════════════
// BCEA LEAVE ENTITLEMENTS
// ═══════════════════════════════════════════════════════════════════════════

describe('BCEA Leave Entitlements', () => {
  it('annual leave is 15 working days per year', () => {
    expect(BCEA_LEAVE_ENTITLEMENTS.annual.daysPerYear).toBe(15);
  });

  it('sick leave is 30 days per 3-year cycle', () => {
    expect(BCEA_LEAVE_ENTITLEMENTS.sick.daysPerCycle).toBe(30);
    expect(BCEA_LEAVE_ENTITLEMENTS.sick.cycleYears).toBe(3);
  });

  it('family responsibility leave is 3 days per year', () => {
    expect(BCEA_LEAVE_ENTITLEMENTS.family_responsibility.daysPerYear).toBe(3);
  });

  it('maternity leave is 4 consecutive months', () => {
    expect(BCEA_LEAVE_ENTITLEMENTS.maternity.months).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE ACCRUAL CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Leave Accrual Calculation', () => {
  it('calculates monthly annual leave accrual', () => {
    // 15 days / 12 months = 1.25 days per month
    const result = calculateLeaveAccrual('annual', 1);
    expect(result).toBeCloseTo(1.25, 2);
  });

  it('calculates quarterly annual leave accrual', () => {
    const result = calculateLeaveAccrual('annual', 3);
    expect(result).toBeCloseTo(3.75, 2);
  });

  it('calculates full year annual leave accrual', () => {
    const result = calculateLeaveAccrual('annual', 12);
    expect(result).toBe(15);
  });

  it('calculates sick leave accrual per year', () => {
    // 30 days / 3 years = 10 days per year = 0.833 per month
    const result = calculateLeaveAccrual('sick', 12);
    expect(result).toBeCloseTo(10, 0);
  });

  it('calculates family responsibility leave accrual', () => {
    const result = calculateLeaveAccrual('family_responsibility', 12);
    expect(result).toBe(3);
  });

  it('returns 0 for zero months', () => {
    expect(calculateLeaveAccrual('annual', 0)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE BALANCE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Leave Balance Calculation', () => {
  it('calculates balance from accrued minus taken', () => {
    const result = calculateLeaveBalance({
      accrued: 15,
      taken: 5,
      adjustment: 0,
    });
    expect(result).toBe(10);
  });

  it('handles adjustments (positive)', () => {
    const result = calculateLeaveBalance({
      accrued: 10,
      taken: 3,
      adjustment: 2,
    });
    expect(result).toBe(9);
  });

  it('handles adjustments (negative)', () => {
    const result = calculateLeaveBalance({
      accrued: 10,
      taken: 3,
      adjustment: -2,
    });
    expect(result).toBe(5);
  });

  it('can go negative (negative balance = leave advance)', () => {
    const result = calculateLeaveBalance({
      accrued: 5,
      taken: 8,
      adjustment: 0,
    });
    expect(result).toBe(-3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE APPLICATION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Leave Application Validation', () => {
  const validApplication: LeaveApplicationInput = {
    employeeId: 'emp-001',
    leaveType: 'annual',
    startDate: '2026-04-01',
    endDate: '2026-04-05',
    days: 5,
    reason: 'Holiday',
    availableBalance: 10,
  };

  it('accepts valid application', () => {
    expect(validateLeaveApplication(validApplication).success).toBe(true);
  });

  it('rejects missing employee', () => {
    expect(validateLeaveApplication({ ...validApplication, employeeId: '' }).success).toBe(false);
  });

  it('rejects end date before start date', () => {
    expect(validateLeaveApplication({
      ...validApplication,
      startDate: '2026-04-10',
      endDate: '2026-04-05',
    }).success).toBe(false);
  });

  it('rejects zero days', () => {
    expect(validateLeaveApplication({ ...validApplication, days: 0 }).success).toBe(false);
  });

  it('rejects negative days', () => {
    expect(validateLeaveApplication({ ...validApplication, days: -1 }).success).toBe(false);
  });

  it('warns when days exceed available balance', () => {
    const result = validateLeaveApplication({
      ...validApplication,
      days: 12,
      availableBalance: 10,
    });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  it('accepts valid leave types', () => {
    for (const t of ['annual', 'sick', 'family_responsibility', 'maternity', 'unpaid', 'study']) {
      expect(validateLeaveApplication({ ...validApplication, leaveType: t as any }).success).toBe(true);
    }
  });

  it('rejects invalid leave type', () => {
    expect(validateLeaveApplication({ ...validApplication, leaveType: 'invalid' as any }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TERMINATION PAYOUT CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Termination Payout Calculation', () => {
  it('calculates leave payout on termination', () => {
    const result = calculateTerminationPayout({
      monthlySalary: 30000,
      unusedLeaveDays: 10,
      noticePeriodDays: 30,
      servedNoticeDays: 0,
      severanceWeeks: 0,
      yearsOfService: 3,
    });
    // Daily rate: 30000 / 21.67 ≈ 1384.63
    // Leave payout: 10 * 1384.63 = 13846.30
    expect(result.leavePayout).toBeGreaterThan(13000);
    expect(result.leavePayout).toBeLessThan(14500);
  });

  it('calculates notice pay when notice not served', () => {
    const result = calculateTerminationPayout({
      monthlySalary: 30000,
      unusedLeaveDays: 0,
      noticePeriodDays: 30,
      servedNoticeDays: 0,
      severanceWeeks: 0,
      yearsOfService: 3,
    });
    // 30 days * (30000/21.67) = 30 * 1384.63 = 41,538.90
    expect(result.noticePay).toBeGreaterThan(40000);
    expect(result.noticePay).toBeLessThan(42000);
  });

  it('calculates partial notice pay', () => {
    const result = calculateTerminationPayout({
      monthlySalary: 30000,
      unusedLeaveDays: 0,
      noticePeriodDays: 30,
      servedNoticeDays: 15,
      severanceWeeks: 0,
      yearsOfService: 3,
    });
    // 15 remaining days * (30000/21.67) ≈ 20,769
    expect(result.noticePay).toBeGreaterThan(20000);
    expect(result.noticePay).toBeLessThan(21500);
  });

  it('calculates severance pay per BCEA (1 week per year of service)', () => {
    const result = calculateTerminationPayout({
      monthlySalary: 30000,
      unusedLeaveDays: 0,
      noticePeriodDays: 0,
      servedNoticeDays: 0,
      severanceWeeks: 1, // 1 week per year
      yearsOfService: 5,
    });
    // Weekly rate: 30000 / 4.333 ≈ 6923
    // 5 years * 1 week = 5 weeks ≈ 34615
    expect(result.severancePay).toBeGreaterThan(30000);
    expect(result.severancePay).toBeLessThan(40000);
  });

  it('calculates total payout', () => {
    const result = calculateTerminationPayout({
      monthlySalary: 30000,
      unusedLeaveDays: 5,
      noticePeriodDays: 30,
      servedNoticeDays: 30,
      severanceWeeks: 0,
      yearsOfService: 2,
    });
    expect(result.totalPayout).toBe(result.leavePayout + result.noticePay + result.severancePay);
  });

  it('returns zero when nothing owed', () => {
    const result = calculateTerminationPayout({
      monthlySalary: 30000,
      unusedLeaveDays: 0,
      noticePeriodDays: 0,
      servedNoticeDays: 0,
      severanceWeeks: 0,
      yearsOfService: 1,
    });
    expect(result.totalPayout).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OVERTIME CALCULATION (BCEA)
// ═══════════════════════════════════════════════════════════════════════════

describe('Overtime Calculation (BCEA)', () => {
  it('calculates weekday overtime at 1.5x', () => {
    const result = calculateOvertimePay({
      hourlyRate: 100,
      weekdayHours: 5,
      saturdayHours: 0,
      sundayHours: 0,
      publicHolidayHours: 0,
    });
    expect(result.weekdayPay).toBe(750); // 5 * 100 * 1.5
  });

  it('calculates Saturday overtime at 1.5x', () => {
    const result = calculateOvertimePay({
      hourlyRate: 100,
      weekdayHours: 0,
      saturdayHours: 8,
      sundayHours: 0,
      publicHolidayHours: 0,
    });
    expect(result.saturdayPay).toBe(1200); // 8 * 100 * 1.5
  });

  it('calculates Sunday overtime at 2x', () => {
    const result = calculateOvertimePay({
      hourlyRate: 100,
      weekdayHours: 0,
      saturdayHours: 0,
      sundayHours: 8,
      publicHolidayHours: 0,
    });
    expect(result.sundayPay).toBe(1600); // 8 * 100 * 2.0
  });

  it('calculates public holiday at 2x', () => {
    const result = calculateOvertimePay({
      hourlyRate: 100,
      weekdayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      publicHolidayHours: 8,
    });
    expect(result.publicHolidayPay).toBe(1600); // 8 * 100 * 2.0
  });

  it('calculates total overtime pay', () => {
    const result = calculateOvertimePay({
      hourlyRate: 100,
      weekdayHours: 3,
      saturdayHours: 4,
      sundayHours: 2,
      publicHolidayHours: 0,
    });
    // 3*150 + 4*150 + 2*200 = 450 + 600 + 400 = 1450
    expect(result.totalPay).toBe(1450);
  });

  it('returns zero for no overtime', () => {
    const result = calculateOvertimePay({
      hourlyRate: 100,
      weekdayHours: 0,
      saturdayHours: 0,
      sundayHours: 0,
      publicHolidayHours: 0,
    });
    expect(result.totalPay).toBe(0);
  });
});
