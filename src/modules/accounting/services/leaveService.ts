/**
 * Leave Management Service — BCEA-compliant leave, termination, overtime
 * Pure business logic — no database dependencies.
 */

export type LeaveType = 'annual' | 'sick' | 'family_responsibility' | 'maternity' | 'unpaid' | 'study';

export interface LeaveApplicationInput {
  employeeId: string;
  leaveType: LeaveType | string;
  startDate: string;
  endDate: string;
  days: number;
  reason?: string;
  availableBalance: number;
}

export interface TerminationInput {
  monthlySalary: number;
  unusedLeaveDays: number;
  noticePeriodDays: number;
  servedNoticeDays: number;
  severanceWeeks: number; // weeks per year of service
  yearsOfService: number;
}

export interface TerminationResult {
  leavePayout: number;
  noticePay: number;
  severancePay: number;
  totalPayout: number;
}

export interface OvertimeInput {
  hourlyRate: number;
  weekdayHours: number;
  saturdayHours: number;
  sundayHours: number;
  publicHolidayHours: number;
}

export interface OvertimeResult {
  weekdayPay: number;
  saturdayPay: number;
  sundayPay: number;
  publicHolidayPay: number;
  totalPay: number;
}

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ field: string; message: string }>;
  warnings?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// BCEA LEAVE ENTITLEMENTS
// ═══════════════════════════════════════════════════════════════════════════

export const BCEA_LEAVE_ENTITLEMENTS = {
  annual: { daysPerYear: 15, description: '15 working days per year (1.25 per month)' },
  sick: { daysPerCycle: 30, cycleYears: 3, description: '30 days per 3-year cycle (10 per year)' },
  family_responsibility: { daysPerYear: 3, description: '3 days per year' },
  maternity: { months: 4, description: '4 consecutive months' },
  unpaid: { daysPerYear: 0, description: 'Unpaid leave — no entitlement' },
  study: { daysPerYear: 0, description: 'Study leave — per company policy' },
} as const;

const VALID_LEAVE_TYPES: LeaveType[] = ['annual', 'sick', 'family_responsibility', 'maternity', 'unpaid', 'study'];
const WORKING_DAYS_PER_MONTH = 21.67;
const WEEKS_PER_MONTH = 4.333;

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE ACCRUAL
// ═══════════════════════════════════════════════════════════════════════════

export function calculateLeaveAccrual(leaveType: LeaveType | string, months: number): number {
  if (months <= 0) return 0;

  switch (leaveType) {
    case 'annual':
      return Math.round((BCEA_LEAVE_ENTITLEMENTS.annual.daysPerYear / 12) * months * 100) / 100;
    case 'sick':
      return Math.round((BCEA_LEAVE_ENTITLEMENTS.sick.daysPerCycle / BCEA_LEAVE_ENTITLEMENTS.sick.cycleYears / 12) * months * 100) / 100;
    case 'family_responsibility':
      return Math.round((BCEA_LEAVE_ENTITLEMENTS.family_responsibility.daysPerYear / 12) * months * 100) / 100;
    default:
      return 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE BALANCE
// ═══════════════════════════════════════════════════════════════════════════

export function calculateLeaveBalance(input: { accrued: number; taken: number; adjustment: number }): number {
  return Math.round((input.accrued - input.taken + input.adjustment) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAVE APPLICATION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export function validateLeaveApplication(input: LeaveApplicationInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  const warnings: string[] = [];

  if (!input.employeeId || input.employeeId.trim() === '') errors.push({ field: 'employeeId', message: 'Employee is required' });
  if (!input.leaveType || !VALID_LEAVE_TYPES.includes(input.leaveType as LeaveType)) errors.push({ field: 'leaveType', message: 'Invalid leave type' });
  if (!input.days || input.days <= 0) errors.push({ field: 'days', message: 'Days must be greater than zero' });

  if (input.startDate && input.endDate) {
    if (new Date(input.endDate) < new Date(input.startDate)) {
      errors.push({ field: 'endDate', message: 'End date cannot be before start date' });
    }
  }

  if (input.days > input.availableBalance) {
    warnings.push(`Requested ${input.days} days but only ${input.availableBalance} available. This will create a negative balance.`);
  }

  return {
    success: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TERMINATION PAYOUT
// ═══════════════════════════════════════════════════════════════════════════

export function calculateTerminationPayout(input: TerminationInput): TerminationResult {
  const dailyRate = input.monthlySalary / WORKING_DAYS_PER_MONTH;
  const weeklyRate = input.monthlySalary / WEEKS_PER_MONTH;

  const leavePayout = Math.round(input.unusedLeaveDays * dailyRate * 100) / 100;

  const remainingNoticeDays = Math.max(0, input.noticePeriodDays - input.servedNoticeDays);
  const noticePay = Math.round(remainingNoticeDays * dailyRate * 100) / 100;

  const severanceWeeksTotal = input.severanceWeeks * input.yearsOfService;
  const severancePay = Math.round(severanceWeeksTotal * weeklyRate * 100) / 100;

  return {
    leavePayout,
    noticePay,
    severancePay,
    totalPayout: Math.round((leavePayout + noticePay + severancePay) * 100) / 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// OVERTIME CALCULATION (BCEA)
// ═══════════════════════════════════════════════════════════════════════════

export function calculateOvertimePay(input: OvertimeInput): OvertimeResult {
  const weekdayPay = Math.round(input.weekdayHours * input.hourlyRate * 1.5 * 100) / 100;
  const saturdayPay = Math.round(input.saturdayHours * input.hourlyRate * 1.5 * 100) / 100;
  const sundayPay = Math.round(input.sundayHours * input.hourlyRate * 2.0 * 100) / 100;
  const publicHolidayPay = Math.round(input.publicHolidayHours * input.hourlyRate * 2.0 * 100) / 100;

  return {
    weekdayPay,
    saturdayPay,
    sundayPay,
    publicHolidayPay,
    totalPay: Math.round((weekdayPay + saturdayPay + sundayPay + publicHolidayPay) * 100) / 100,
  };
}
