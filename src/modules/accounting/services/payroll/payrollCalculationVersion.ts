/**
 * The version of the pay-run calculation, stamped on the run header with calculated_at (migration 953) by every
 * calculation (payrollRunLock.saveCalculatedRunTotals). The approval gate (payrollRunRecalcGate) refuses a run whose
 * stamp is missing (calculated before 953) or older than this: its lines were read under other rules, so recalculate.
 * Bump it when a change alters what a calculation writes for the same inputs.
 *
 * 1: components read on the period's last day; once-offs inside the month; pro-rata and termination-base flags.
 * 2: an unaffordable loan keeps its taxable 3801 benefit while omitting the cash instalment.
 * 3: s18A donations need a receipt and stop at 5%, off PAYE and SDL (migration 959).
 * 4: only retirement contributions and s18A donations reduce PAYE; any other taxable deduction is warned.
 * 5: an hourly or daily employee with no hours or days on the run is flagged HOURS_MISSING and refused at approval (HD).
 */
export const PAYROLL_CALCULATION_VERSION = 5;
