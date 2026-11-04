/**
 * The version of the pay-run calculation, stamped on the run header with calculated_at (migration 953) by every
 * calculation (payrollRunLock.saveCalculatedRunTotals). The approval gate (payrollRunRecalcGate) refuses a run whose
 * stamp is missing (calculated before 953) or older than this: its lines were read under other rules, so recalculate.
 * Bump it when a change alters what a calculation writes for the same inputs.
 *
 * 1: components read on the period's last day; once-offs inside the month; pro-rata and termination-base flags.
 */
export const PAYROLL_CALCULATION_VERSION = 1;
