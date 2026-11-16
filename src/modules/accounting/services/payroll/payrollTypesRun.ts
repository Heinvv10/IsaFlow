/**
 * Run-header types, split out of payrollTypes.ts (which re-exports them) to keep that file under the 300-line cap.
 */

export interface PayrollPeriod {
  month: number;
  year: number;
}

/** How often an employee is paid and a run pays (migration 999a). This release costs only 'monthly' (payrollRunKindGuard). */
export const PAY_FREQUENCIES = ['monthly', 'fortnightly', 'weekly'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];
/** A regular run pays a period; an off-cycle run pays a bonus or a termination outside it (999a; refused this release). */
export type RunKind = 'regular' | 'off_cycle';
export type OffCycleReason = 'bonus' | 'termination';
