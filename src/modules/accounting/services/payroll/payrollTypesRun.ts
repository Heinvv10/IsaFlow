/**
 * Run-header types, split out of payrollTypes.ts (which re-exports them) to keep that file under the 300-line cap.
 */

export interface PayrollPeriod {
  month: number;
  year: number;
}
