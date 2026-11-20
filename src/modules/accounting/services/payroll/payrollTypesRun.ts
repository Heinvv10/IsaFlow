/**
 * Run-header types, split out of payrollTypes.ts (which re-exports them) to keep that file under the 300-line cap.
 */

export interface PayrollPeriod {
  /** The EMP201 month: a weekly or fortnightly run's is its pay date's month (Fourth Schedule para 2(1); wave 6 FQc). */
  month: number;
  year: number;
  /**
   * The run's own dates, 'YYYY-MM-DD' (payroll_run_headers.period_start / period_end, migration 999a). Absent = the
   * calendar month, which is what a monthly regular run's are: a reader keyed by these (payrollRunReadDate, the once-off
   * window, the pro-rata band, the run population) reads a monthly run exactly as it read the month (wave 6 FQc).
   */
  start?: string;
  end?: string;
}

/** How often an employee is paid and a run pays (migration 999a). This release costs only 'monthly' (payrollRunKindGuard). */
export const PAY_FREQUENCIES = ['monthly', 'fortnightly', 'weekly'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];
/** A regular run pays a period; an off-cycle run pays a bonus or a termination outside it (999a; refused this release). */
export type RunKind = 'regular' | 'off_cycle';
export type OffCycleReason = 'bonus' | 'termination';
/**
 * A column value this release does not know (a later release widened its CHECK). The row is still read and listed;
 * payrollRunKindGuard refuses to act on it (it reads the database, not this value), and a run-population query bound to
 * it matches nobody. Never written.
 */
export type UnsupportedValue = 'unsupported';

/** A weekly or fortnightly run's ETI parts (payrollLineEtiMonth), stored on its line's ETI_MONTH_PENDING result. */
export interface EtiMonthParts {
  /** ETI "monthly remuneration" the line paid (etiRemunerationOf). */
  remuneration: number;
  /** The wage for ordinary hours, in cents (ordinaryWageCents). */
  wageCents: number;
  /** Hourly or daily pay basis: the run's ordinary hours (null when not told). Otherwise null: the month's are derived. */
  ordinaryHours: number | null;
  /** Overtime hours paid (3607, overtimeHours). */
  overtimeHours: number;
}

/**
 * How a weekly or fortnightly line is costed (wave 6 FQc). Absent on PayrollLineInput = monthly, costed as before.
 */
export interface LineCadence {
  frequency: PayFrequency;
  /** The run's dates (also on `period`); the starter's share of the period is read from them (payFrequencyPeriods). */
  periodStart: string;
  periodEnd: string;
  /**
   * UIF-leviable remuneration on this employee's earlier final runs paid in the same month: the ceiling is on the
   * remuneration paid "during any month" (UIC Act 4 of 2002 s6(1)(a) and s6(2)).
   */
  uifMonthToDate: number;
  /** Null: a later run of this frequency is paid in the same month, so ETI waits (ETI_MONTH_PENDING). Else: this run
   *  closes the month, and these are the month's earlier runs' parts, summed. */
  etiMonthToDate: EtiMonthParts | null;
}
